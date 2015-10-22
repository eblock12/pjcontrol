var serialport = require('serialport');
var log = require('simple-node-logger').createSimpleLogger('pjcontrol.log');
var Enum = require('enum');
var argv = require('yargs').argv;
var express = require('express');

if (argv.debug) {
    log.setLevel('debug');
}

var port = new serialport.SerialPort('/dev/ttyAMA0', {
    baudrate: 38400,
    databits: 8,
    stopbits: 1,
    parity: 'even',
    flowcontrol: false,
    parser: serialport.parsers.raw,
}, false /*openImmediately*/);

var PowerStatus = new Enum({
    'Unknown': -1,
    'Standby': 0,
    'Startup': 1,
    'StartupLamp': 2,
    'PowerOn': 3,
    'Cooling1': 4,
    'Cooling2': 5,
    'SavingCooling1': 6,
    'SavingCooling2': 7,
    'SavingStandby': 8
});

var PowerPollRate = 5000;

var projector = {};
projector.powerStatus = PowerStatus.Unknown;

var portOpenCallback = function(){};
var portIsOpening = false; // waiting for port to open
var portIsSending = false; // command in transmission
var portIsWaiting = false; // awaiting response from projector

var commandQueue = [];
var activeCommand = null;

function attachPortHandlers() {
    log.debug('attachPortHandlers');

    port.removeAllListeners();

    port.on('open', function() {
        log.debug('onPortOpen');

        port.on('data', function(data) {
            log.debug('R: ' + bytesAsString(data));
            var response = decodeResponse(data);
            if (activeCommand) {
                if (response) {
                    activeCommand.success(response);
                } else {
                    activeCommand.failure();
                }
                activeCommand = null;
            }
            portIsWaiting = false;
            tickCommandQueue();
        });

        portOpenCallback();
        portOpenCallback = function(){};
    });
}

function ensurePortOpen(cb) {
    log.debug('ensurePortOpen');
    
    if (!cb) {
        cb = function() {};
    }

    function openPort() {
        log.info('Attempting to open the serial port...');

        portIsOpening = true;
        portIsSending = false;
        portIsWaiting = false;
        activeCommand = null;

        port.open(function(err) {
            if (err) {
                log.error('Error opening the serial port. ' + err);
                setTimeout(openPort, 5000); // retry in 5 seconds
            } else {
                log.info('Serial port opened');
                portIsOpening = false;
                tickCommandQueue();
            }
        });
    }

    if (port.isOpen()) {
        cb();
    } else {
        var preserveOpenCallback = portOpenCallback;
        portOpenCallback = function() { preserveOpenCallback(); cb(); };
        if (!portIsOpening) {
            attachPortHandlers();
            openPort();
        }
    }
}

function tickCommandQueue() {
    log.debug('tickCommandQueue');
    
    if (!commandQueue.length || portIsOpening || portIsWaiting || portIsSending) {
        return;
    }

    ensurePortOpen();
    if (!port.isOpen()) {
        return;
    }

    var command = commandQueue.shift();
    if (command) {
        portIsSending = true;
        log.debug('S: ' + bytesAsString(command.bytes));
        port.write(command.bytes, function(err, bytesSent) {
            if (err) {
                log.error('Error when sending command. ' + err);
                command.failure();
                activeCommand = null;
            } else {
                activeCommand = command;
                log.debug('Sent ' + bytesSent + ' bytes');
                if (commandNeedsReply(command.bytes)) { 
                    portIsWaiting = true;
                    activeCommand = command;
                } else {
                    activeCommand = null;
                    command.success();
                }
            }
            portIsSending = false;
            setImmediate(tickCommandQueue);
        });
    }
}

function computeChecksum(buf) { 
    return (buf[1] | buf[2] | buf[3] | buf[4] | buf[5]) & 0xFF;
}

function commandNeedsReply(buf) {
    switch (buf[1]) {
        // Projector sends no response for IR commands
        case 0x17:
        case 0x19:
        case 0x1B:
            return false;
    }
    return true;
}

function bytesAsString(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i++) {
        str += bytes[i].toString(16).toUpperCase() + ' ';
    }
    return str;
}

function decodeResponse(response) {
    log.debug('decodeResponse');
    
    if (response.length !== 8) {
        log.error('Invalid response, incorrect packet length');
    } else if (response[0] !== 0xA9) {
        log.error('Invalid response, missing start code');
    } else if (response[7] !== 0x9A) {
        log.error('Invalid response, missing end code');
    } else if ((response[3] !== 0x03) && (response[3] !== 0x02)) {
        log.error('Invalid respnse, type code is unknown');
    } else if (response[6] !== computeChecksum(response)) {
        log.error('Invalid response, checksum mismatch');
    } else {
        var msg = {};
        msg.itemNum = ((response[1] & 0xFF) << 8) | (response[2] & 0xFF);
        msg.data = ((response[4] & 0xFF) << 8) | (response[5] & 0xFF);
        msg.isReply = (response[3] === 0x02);
        log.debug('Got response, item=0x' + msg.itemNum.toString(16) + ', data=0x' + msg.data.toString(16) + ', isReply=' + msg.isReply);
        return msg;
    }
}

function sendCommand(itemNum, isGet, data, success, failure) {
    var buf = [];

    if (!itemNum) {
        itemNum = 0x0000;
    }
    if (!data) {
        data = 0x0000;
    }
    if (!success) {
        success = function(){};
    }
    if (!failure) {
        failure = function(){};
    }

    buf.push(0xA9); // start code
    buf.push(itemNum >> 8);
    buf.push(itemNum & 0xFF);
    buf.push(isGet ? 0x01 : 0x00);
    buf.push(data >> 8);
    buf.push(data & 0xFF);
    buf.push(computeChecksum(buf));
    buf.push(0x9A); // end code

    commandQueue.push({
        bytes: buf,
        success: success,
        failure: failure
    });
    tickCommandQueue();
}

function pollPowerStatus() {
    sendCommand(0x0102, true /*isGet*/, 0x0, function(msg) {
        var oldStatus = projector.powerStatus;
        projector.powerStatus = PowerStatus.get(msg.data);
        if (oldStatus.value !== projector.powerStatus.value) {
            log.info('Power state: "' + projector.powerStatus.toString() + '"');
        }
        setTimeout(pollPowerStatus, PowerPollRate);
    });
}

function sendPowerOn(success, failure) {
    sendCommand(0x172E, false /*isGet*/, 0x0, function(msg) {
        log.info('Sent "Power On" command');
        success();
    }, function() {
        failure();
    });
}

function sendPowerOff(success, failure) {
    sendCommand(0x172F, false /*isGet*/, 0x0, function(msg) {
        log.info('Sent "Power Off" command');
        success();
    }, function() {
        failure();
    });
}

pollPowerStatus();

var app = express();
var router = express.Router();

router.get('/statusPower', function(req, res) {
    res.json({ value: projector.powerStatus.toString() });
});

router.post('/powerOn', function(req, res) {
    sendPowerOn(function() {
        res.status(200).send();
    }, function() {
        res.status(500).send();
    });
});

router.post('/powerOff', function(req, res) {
    sendPowerOff(function() {
        res.status(200).send();
    }, function() {
        res.status(500).send();
    });
});

app.use('/api', router);

app.listen(8080);
log.info('Listening for HTTP requests on port 8080...');

