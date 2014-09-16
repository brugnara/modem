var EventEmitter = require('events').EventEmitter;

var handlers = require('./handlers');

function initModem() {
  var modem = this.modem = new EventEmitter();

  // Holds queue of commands to be executed.
  modem.queue = [];
  // Device status
  modem.isLocked = false;
  // List of stored partial messages
  modem.partials = {};
  modem.isOpened = false;
  modem.job_id = 1;
  // Should USSD queries be done in PDU mode?
  modem.ussd_pdu = true;

  // For each job, there will be a timeout stored here. We cant store timeout in item's themselves because timeout's are
  // circular objects and we want to JSON them to send them over sock.io which would be problematic.
  var timeouts = {};

  for (var key in handlers) {
    modem[key] = handlers[key];
  }

  modem.on('newListener', function(listener) {
    // If user wants to get sms events, we have to ask modem to give us notices.
    if (listener == 'sms received') {
      this.execute('AT+CNMI=2,1,0,2,0');
    }

    if (listener == 'ring') {
      this.execute('AT+CLIP=1');
    }
  });

  return modem;
}

function CreateModem() {
  return initModem();
}


module.exports = CreateModem;
