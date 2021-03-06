module.exports = function(app){

  var crypto = require('crypto')
    , async = require('async')
    , config = require('./config')
    , utils = require('./utils')
    , db = app.db;
    ;
  
  // attach namespace connection handlers to the io-enabled apps
  for (var i = 0; i < app.listeners.length; i++) {
    app.listeners[i].io.of('/gs').on('connection', handleGSSocketAuthorization);
    app.listeners[i].io.of('/web').on('connection', handleWebSocketConnection);
  }
  
  // basic web client socket connections. only one event is implemented currently.
  function handleWebSocketConnection(socket) {
    socket.on('join-mid',function(mid){
      socket.join(mid);
    });
  }
  
  // Begin authorization of the new groundstation socket connection. 
  // When the client initiates the auth process, they will send a gsid
  // that we will use to look up the gs key for performing an hmac
  // challenge/response using random data. The connection is logged.
  function handleGSSocketAuthorization(socket) {
    socket.on('auth-initiate', function(gsid) {
      var challenge = {
        alg: 'sha512', // hash algorithm
        enc: 'base64' // hash encoding
      };
      async.parallel({
        // create a random byte buffer that will become the hmac challenge
        rand: function(callback) {
          crypto.randomBytes(256, callback);
        },
        // lookup the security key for the provided gsid
        gs: function(callback) {
          db.models.Groundstation.findOne({ _id:db.mongoose.Types.ObjectId(gsid)}).select('key').exec(callback);
        },
        // log the access attempt (defaults to fail, can update to pass later)
        log: function(callback) {
          db.models.AccessLog.create({
            gsid: gsid,
            ip: socket.handshake.headers['x-forwarded-for'] || socket.handshake.address.address
          }, callback);
        }
      },
      function(err, results) {
        if (err || !(results.gs && results.gs.key) ) {
          utils.logText('GS ' + results.log.gsid + ' Lookup', 'DENY'.yellow);
          socket.emit('auth-fail');
          socket.disconnect();
          return;
        } 
        challenge.data = results.rand.toString('hex');
        var answer = crypto
          .createHmac(challenge.alg, results.gs.key)
          .update(challenge.data)
          .digest(challenge.enc);
        socket.emit('auth-challenge', challenge, function(response) {
          if(response != answer) {
            socket.emit('auth-fail');
            socket.disconnect();
            utils.logText('GS ' + results.log.gsid + ' Challenge', 'DENY'.yellow);
            return;
          }
          socket.gs = results.gs;
          socket.accesslog = results.log;
          handleGSSocketConnection(socket);
          utils.logText('GS ' + results.log.gsid, 'AUTH'.green);
          socket.emit('auth-pass');
          results.log.auth = true;
          results.log.save();
        });
      });
    });
  }
  
  function handleGSSocketConnection(socket) {
    socket.on('disconnect', function() {
      utils.logText('GS ' + socket.accesslog.gsid, 'DISC'.yellow);
    });
    
    socket.on('descriptor-request', function(desc_typeid, callback) {
      var data = [];
      if(typeof desc_typeid !== 'string' || desc_typeid.length <= 0) {
        utils.logText('Descriptor request invalid');
        callback(data);
        return;
      }
      utils.logText('Descriptor request for ' + desc_typeid);
      db.funcs.loadPacketDescriptors(desc_typeid, function(err,descriptors){
        for(var i in descriptors) {
          descriptors[i] = descriptors[i].toJSON(); // needed to make the object purely JSON, no mongoose stuff
          data[i] = {
            h: descriptors[i].h,
            p: descriptors[i].p, 
          };
        }
        callback(data);
      });
    });
    
    socket.on('tap', function(packet) {
      recordTAP(packet, socket);
      logPacket(packet, 'TAP', 'from GS ' + socket.accesslog.gsid);
    });
  } 
  
  
  function recordTAP(tap, socket) {
    db.funcs.loadPacketModel('TAP_'+tap.h.t, function(tapmodel){
      if(tapmodel) {
        tapmodel.create(tap , function (err, newtap) {
          if (err && err.code == 11000) { // duplicate key error
            createConfirmation(socket.accesslog.gsid, tap, 'TAP_' + tap.h.t + ' already logged'.red, socket);
          } else if(err) {
            createConfirmation(socket.accesslog.gsid, tap, 'TAP_' + tap.h.t + ' not saved - db error'.red, socket);
            utils.log(err);
          } else {
            createConfirmation(socket.accesslog.gsid, tap, newtap._t + ' logged'.green, socket);
            for (var i = 0; i < app.listeners.length; i++) {
              app.listeners[i].io.of('/web').in(tap.h.mid).emit('new-tap', newtap._t);
            }
            
            findCAPs(newtap, socket);
          }
        });
      } else {
        createConfirmation(socket.accesslog.gsid, tap, 'TAP_' + tap.h.t + ' unknown'.red, socket);
      }
    });
  }
  
  
  function findCAPs(TAPrecord, socket) {
    db.models.CAP.find({'h.mid':TAPrecord.h.mid, 'td': null }).exec(function(err, caps){
      for(var i in caps) {
        caps[i].td = new Date();
        caps[i].save();
        var cap = caps[i].toObject();
        cap = { h: cap.h, p: cap.p };
        socket.emit('cap',cap);
        logPacket(cap, 'CAP', 'to GS ' + socket.accesslog.gsid);
      }
    });
  }
  
  
  function createConfirmation(gsid, packet, text, socket) {
    var hash = crypto.createHash('sha1').update(JSON.stringify(packet)).digest('hex');
    packet = hash.substring(0,6) + ' ' + text;
    socket.emit('info',packet);
    //logPacket(packet, 'INF', 'to GS ' + gsid);
  }
  
  function logPacket(packet, TYPE, text, hash) {
    if(!hash) hash = crypto.createHash('sha1').update(JSON.stringify(packet)).digest('hex');
    utils.log((utils.napcolors[TYPE] ? utils.napcolors[TYPE] : '') + TYPE + utils.napcolors.RST + ' ' + hash.substring(0,6) + ' ' + text, packet);
  }
  
}
