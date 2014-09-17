
var EventEmitter = require('events').EventEmitter;
var pdu = require('pdu');
var sp = require('serialport');
var once = require('once');

var timeouts = {};

module.exports = {
  // Adds a command to execution queue.
  // Command is the AT command, c is callback. If prior is true, the command will be added to the beginning of
  // the queue (It has priority).
  execute: function(command, c, prior, timeout) {
    if (!this.isOpened) {
      this.emit('close');
      return ;
    }

    var item = new EventEmitter();
    item.command = command;
    item.callback = once(c);
    item.add_time = new Date();
    item.id = ++this.job_id;
    item.timeout = timeout;
    //Default timeout it 60 seconds. Send false to disable timeouts.
    if (!item.timeout) {
      item.timeout = 60000;
    }

    if (prior) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }

    this.emit('job', item);
    process.nextTick(this.executeNext.bind(this));
    return item;
  },

  // Executes the first item in the queue.
  executeNext: function() {
    if (!this.isOpened) {
      this.emit('close');
      return;
    }
    //Someone else is running. Wait.
    if (this.isLocked) {
      return;
    }

    var item = this.queue[0];

    //Queue is empty.
    if (!item) {
      this.emit('idle');
      return;
    }

    //Lock the device and null the data buffer for this command.
    this.data = '';
    this.isLocked = true;

    item.execute_time = new Date();

    item.emit('start');

    if (item.timeout) {
      timeouts[item.id] = setTimeout(function () {
        item.callback && item.callback('timedout');
        item.emit('timeout');
        this.release();
        this.executeNext();
      }.bind(this), item.timeout);
    }

    this.port.write(item['command']+"\r");
  },

  open: function(device, callback) {
    this.port = new sp.SerialPort(device, {
      parser: sp.parsers.raw
    });

    this.port.on('open', function() {
      this.isOpened = true;
      this.port.on('data', this.dataReceived.bind(this));
      this.emit('open');
      callback && callback.bind(this)();
    }.bind(this));

    this.port.on('close', function() {
      this.port.close();
      this.isOpened = false;
      this.emit('close');
    }.bind(this));

    this.port.on('error', function() {
      this.close();
      callback && callback('Serial port error');
    }.bind(this));
  },

  close: function(device) {
    this.port.removeAllListeners();
    if (this.isOpened) {
      this.port.close();
    }
    this.port = null;
    this.isOpened = false;
    this.emit('close');
  },

  dataReceived: function(buffer) {
    //We dont seriously expect such little amount of data. Ignore it.
    if(buffer.length < 2) {
      return;
    }

    var datas = buffer.toString().trim().split('\r');

    datas.forEach(function(data) {
      // When we write to modem, it gets echoed.
      // Filter out queue we just executed.
      if (this.queue[0] && this.queue[0]['command'].trim().slice(0, data.length) === data) {
        this.queue[0]['command'] = this.queue[0]['command'].slice(data.length);
        return;
      }

      //Emit received data for those who care.
      this.emit('data', data);
      var dataTrimmed = data.trim();
      var resp = dataTrimmed.slice(0,5).trim();

      switch (resp) {
        case '+CMTI':
          this.smsReceived(data);
          return;
        case '+CDSI':
          this.deliveryReceived(data);
          return;
        case '+CLIP':
          this.ring(data);
          return;
      }

      if (dataTrimmed.slice(0,10).trim() === '^SMMEMFULL') {
        this.emit('memory full', this.parseResponse(data)[0]);
        return;
      }

      //We are expecting results to a command. Modem, at the same time, is notifying us (of something).
      //Filter out modem's notification. Its not our response.
      if (this.queue[0] && dataTrimmed.substr(0,1) === '^') {
        return;
      }

      //Command finished running.
      if (dataTrimmed === 'OK' || dataTrimmed.match(/error/i) || dataTrimmed === '>') {
        var cb;
        if(this.queue[0] && this.queue[0]['callback']) {
          cb = this.queue[0]['callback'];
        } else {
          cb = null;
        }

        /*
         Ordering of the following lines is important.
         First, we should release the modem. That will remove the current running item from queue.
         Then, we should call the callback. It might add another item with priority which will be added at the top of the queue.
         Then executeNext will execute the next command.
         */
        if (this.queue[0]) {
          this.queue[0]['end_time'] = new Date();
          this.queue[0].emit('end', this.data, dataTrimmed);
          clearTimeout(timeouts[this.queue[0].id]);
        }

        this.release();
        //Calling the callback and letting her know about data.
        if (cb) {
          cb(this.data, dataTrimmed);
        }
        this.executeNext();
      } else {
        //Rest of data for a command. (Long answers will happen on multiple dataReceived events)
        this.data+= data;
      }
    }.bind(this));
  },

  release: function() {
    //Empty the result buffer.
    this.data = '';
    //release the modem for next command.
    this.isLocked = false;
    //Remove current item from queue.
    this.queue.shift();
  },

  smsReceived: function(cmti) {
    var message_info = this.parseResponse(cmti);
    var memory = message_info[0];
    this.execute('AT+CPMS="' + memory + '"', function(memory_usage) {
      memory_usage = this.parseResponse(memory_usage);
      var used  = parseInt(memory_usage[0]);
      var total = parseInt(memory_usage[1]);

      if (used === total) {
        this.emit('memory full', memory);
      }
    }.bind(this));
    this.execute('AT+CMGR='+message_info[1], function(cmgr) {
      var lines = cmgr.trim().split("\n");
      var message = this.processReceivedPdu(lines[1], message_info[1]);
      if (message) {
        this.emit('sms received', message);
      }
    }.bind(this));
  },

  deliveryReceived: function(delivery) {
    var response = this.parseResponse(delivery);
    this.execute('AT+CPMS="'+response[0]+'"');
    this.execute('AT+CMGR='+response[1], function(cmgr) {
      var lines = cmgr.trim().split("\n");
      var deliveryResponse = pdu.parseStatusReport(lines[1]);
      this.emit('delivery', deliveryResponse, response[1]);
    }.bind(this));
  },

  ring: function(data) {
    var clip = this.parseResponse(data);
    this.emit('ring', clip[0]);
  },

  parseResponse: function(response) {
    var plain = response.slice(response.indexOf(':')+1).trim();
    var parts = plain.split(/,(?=(?:[^"]|"[^"]*")*$)/);
    for (var key in parts) {
      parts[key] = parts[key].replace(/\"/g, '');
    }

    return parts;
  },

  processReceivedPdu: function(pduString, index) {
    try {
      var message = pdu.parse(pduString);
    } catch(error) {
      return;
    }
    message['indexes'] = [index];

    //Messages has no data-header and therefore, is not contatenated.
    if (!message['udh']) {
      return message;
    }

    //Message has some data-header, but its not a contatenated message;
    if (message['udh']['iei'] !== '00' && message['udh']['iei'] !== '08') {
      return message;
    }

    var messagesId = message.sender+'_'+message.udh.reference_number;
    if (!this.partials[messagesId]) {
      this.partials[messagesId] = [];
    }

    this.partials[messagesId].push(message);
    if (this.partials[messagesId].length < message.udh.parts) {
      return;
    }

    var text = '';
    var indexes = [];

    for (var i = 0; i<message.udh.parts; i++) {
      for (var j = 0; j < message.udh.parts; j++) {
        if (this.partials[messagesId][j].udh.current_part === i + 1) {
          text += this.partials[messagesId][j].text;
          indexes.push(this.partials[messagesId][j].indexes[0]);
        }
      }
    }
    //Update text.
    message['text'] = text;
    //Update idex list.
    message['indexes'] = indexes;
    //Remove from partials list.
    delete this.partials[messagesId];

    return message;
  },

  getMessages: function(callback) {
    this.execute('AT+CMGL=1', function(data) {
      var messages = [];
      //TODO: \n AND \r\n
      var lines = data.split("\n");
      var i = 0;
      lines.forEach(function(line) {
        if (line.trim().length === 0) {
          return;
        }

        if (line.slice(0,1) === '+') {
          i = this.parseResponse(line)[0];
          return;
        }

        var message = this.processReceivedPdu(line, i);
        if (message) {
          messages.push(message);
        }
      }.bind(this));

      callback && callback(messages);
    }.bind(this));
  },

  sms: function(message, callback) {
    var i = 0;
    var pdus = pdu.generate(message);
    var ids = [];

    // sendPDU executes 'AT+CMGS=X' command. The modem will give a '>' in response.
    // Then, appendPdu should append the PDU+^Z 'immediately'.
    // Thats why the appendPdu executes the pdu using priority argument of modem.execute.
    // Execute 'AT+CMGS=X', which means modem should get ready to read a PDU of X bytes.
    var sendPdu = function(pdu) {
      this.execute("AT+CMGS="+((pdu.length/2)-1), appendPdu);
    }.bind(this);

    // Response to a AT+CMGS=X is '>'. Which means we should enter PDU. If aything else has been returned, there's an error.
    var appendPdu = function(response, escape_char) {
      // An error has happened.
      if (escape_char !== '>') {
        return callback(response + ' ' + escape_char);
      }

      var job = this.execute(pdus[i] + String.fromCharCode(26), function(response, escape_char) {
        if (escape_char.match(/error/i)) {
          return callback(response+' '+escape_char);
        }

        response = this.parseResponse(response);

        ids.push(response[0]);
        i++;

        if (!pdus[i]) {
          //We've pushed all PDU's and gathered their ID's. calling the callback.
          callback && callback(null, ids);
          this.emit('sms sent', message, ids);
        } else {
          sendPdu(pdus[i]); //There's at least one more PDU to send.
        }
      }.bind(this), true, false);

    }.bind(this);

    sendPdu(pdus[i]);
  },

  deleteMessage: function(index, cb) {
    this.execute('AT+CMGD=' + index, cb);
  }

};