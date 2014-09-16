
var modem = require('./').Modem();

modem.open('/dev/tty.usbserial', function() {

  this.execute('hello', function() {
    console.log('lol');
  })

});