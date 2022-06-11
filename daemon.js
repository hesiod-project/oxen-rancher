// no npm!
const fs = require('fs')
const os = require('os')
const net = require('net')
const dns = require('dns')
const path = require('path')
const lib = require(__dirname + '/lib')
const lokinet = require(__dirname + '/lokinet')
const configUtil = require(__dirname + '/config')
const networkTest = require(__dirname + '/lib.networkTest')
const cp  = require('child_process')
const spawn = cp.spawn
const execSync = cp.execSync
const stdin = process.openStdin()

//const longjohn = require('longjohn')

const VERSION = 0.2
//console.log('loki daemon library version', VERSION, 'registered')

let g_config = false
let server = false
let webApiServer = false
process.on('uncaughtException', function (err) {
  console.trace('Caught exception:', err)
  let var_path = '/tmp'
  if (g_config) var_path = g_config.launcher.var_path
  fs.appendFileSync(var_path + '/launcher_exception.log', JSON.stringify({
    err: err,
    code: err.code,
    msg: err.message,
    trace: err.stack.split("\n")
  }) + "\n")
  // if we're in cimode, throw up red flag
  if (savePidConfig.config && savePidConfig.config.launcher.cimode) {
    process.exit(1)
  }
})

let connections = []
function disconnectAllClients() {
  console.log('SOCKET: Disconnecting all', connections.length, 'clients.')
  for(let i in connections) {
    const conn = connections[i]
    if (!conn.destroyed) {
      //console.log('disconnecting client #'+i)
      conn.destroy()
    }
  }
  connections = [] // clear them
}

// lower permissions and run cb
// don't use this for lokinet on MacOS
function lowerPermissions(user, cb) {
  process.setuid(user)
}

function blockchain_running() {
  return loki_daemon && loki_daemon.pid && lib.isPidRunning(loki_daemon.pid)
}
function storage_running() {
  return storageServer && storageServer.pid && lib.isPidRunning(storageServer.pid)
}
function network_running() {
  let lokinetState = lokinet.isRunning()
  return lokinetState && lokinetState.pid && lib.isPidRunning(lokinetState.pid)
}

function waitfor_blockchain_shutdown(cb) {
  setTimeout(function() {
    if (!blockchain_running()) {
      cb()
    } else {
      waitfor_blockchain_shutdown(cb)
    }
  }, 1000)
}

function shutdown_blockchain() {
  if (loki_daemon) {
    if (loki_daemon.outputFlushTimer) {
      clearInterval(loki_daemon.outputFlushTimer)
      loki_daemon.outputFlushTimer = null
    }
  }
  if (loki_daemon && !loki_daemon.killed) {
    console.log('LAUNCHER: Requesting lokid be shutdown.', loki_daemon.pid)
    try {
      process.kill(loki_daemon.pid, 'SIGINT')
    } catch(e) {
    }
    loki_daemon.killed = true
  }
}

function shutdown_storage() {
  if (storageServer && !storageServer.killed) {
    // FIXME: was killed not set?
    try {
      // if this pid isn't running we crash
      if (lib.isPidRunning(storageServer.pid)) {
        console.log('LAUNCHER: Requesting storageServer be shutdown.', storageServer.pid)
        process.kill(storageServer.pid, 'SIGINT')
      } else {
        console.log('LAUNCHER: ', storageServer.pid, 'is not running')
      }
    } catch(e) {
    }
    // mark that we've tried
    storageServer.killed = true
    // can't null it if we're using killed property
    //storageServer = null
  }
}

let shuttingDown = false
let exitRequested = false
let shutDownTimer = null
let lokinetPidwatcher = false
function shutdown_everything() {
  //console.log('shutdown_everything()!')
  //console.trace('shutdown_everything()!')
  if (lokinetPidwatcher !== false) {
    clearInterval(lokinetPidwatcher)
    lokinetPidwatcher = false
  }
  shuttingDown = true
  stdin.pause()
  shutdown_storage()
  // even if not running, yet, stop any attempts at starting it too
  lokinet.stop()
  lib.stop()
  shutdown_blockchain()
  // clear our start up lock (if needed, will crash if not there)
  lib.clearStartupLock(module.exports.config)
  // kill any blockchain restarts
  module.exports.config.blockchain.restart = false

  // FIXME: should we be savings pids as we shutdown? probably

  // only set this timer once... (and we'll shut ourselves down)
  if (shutDownTimer === null) {
    shutDownTimer = setInterval(function () {
      let stop = true
      if (storage_running()) {
        console.log('LAUNCHER: Storage server still running.')
        stop = false
      }
      if (loki_daemon) {
        if (loki_daemon.outputFlushTimer) {
          // it can and does, if shutdown is called before lokid exits...
          // sig handler?
          //console.log('Should never hit me')
          clearInterval(loki_daemon.outputFlushTimer)
          loki_daemon.outputFlushTimer = null
        }
      }
      if (blockchain_running()) {
        console.log('LAUNCHER: lokid still running.')
        // lokid on macos may need a kill -9 after a couple failed 15
        // lets say 50s of not stopping -15 then wait 30s if still run -9
        stop = false
      } else {
        if (server) {
          console.log('SOCKET: Closing socket server.')
          disconnectAllClients()
          server.close()
          server.unref()
          if (fs.existsSync(module.exports.config.launcher.var_path + '/launcher.socket')) {
            console.log('SOCKET: Cleaning socket.')
            fs.unlinkSync(module.exports.config.launcher.var_path + '/launcher.socket')
          }
          server = false
        }
      }
      const lokinetState = lokinet.isRunning()
      if (network_running()) {
        console.log('LAUNCHER: lokinet still running.')
        stop = false
      }
      if (stop) {
        if (webApiServer) {
          webApiServer.close()
          webApiServer.unref()
          webApiServer = false
        }
        console.log('All daemons down.')
        // deallocate
        // can't null these yet because lokid.onExit
        // race between the pid dying and registering of the exit
        storageServer = null
        loki_daemon = null
        // FIXME: make sure lokinet.js handles this
        // lokinetState = null
        lib.clearPids(module.exports.config)
        /*
        if (fs.existsSync(config.launcher.var_path + '/pids.json')) {
          console.log('LAUNCHER: clearing pids.json')
          fs.unlinkSync(config.launcher.var_path + '/pids.json')
        } else {
          console.log('LAUNCHER: NO pids.json found, can\'t clear')
        }
        */
        clearInterval(shutDownTimer)
        // docker/node 10 on linux has issue with this
        // 10.15 on macos has a handle, probably best to release
        if (stdin.unref) {
          //console.log('unref stdin')
          stdin.unref()
        }
        // if lokinet wasn't started yet, due to slow net/dns stuff
        // then it'll take a long time for a timeout to happen
        // 2 writes, 1 read
        /*
        var handles = process._getActiveHandles()
        console.log('handles', handles.length)
        for(var i in handles) {
          var handle = handles[i]
          console.log(i, 'type', handle._type)
        }
        console.log('requests', process._getActiveRequests().length)
        */
      }
    }, 5000)
  }

  // don't think we need, seems to handle itself
  //console.log('should exit?')
  //process.exit()
}

let storageServer
var storageLogging = true
// you get one per sec... so how many seconds to do you give lokid to recover?
// you don't get one per sec
// 120s
// it's one every 36 seconds
// so lets say 360 = 10
var lastLokidContactFailures = []
function launcherStorageServer(config, args, cb) {
  if (shuttingDown) {
    //if (cb) cb()
    console.log('STORAGE: Not going to start storageServer, shutting down.')
    return
  }
  // no longer true
  /*
  if (!config.storage.lokid_key) {
    console.error('storageServer requires lokid_key to be configured.')
    if (cb) cb(false)
    return
  }
  */

  // set storage port default
  if (!config.storage.port) {
    config.storage.port = 8080
  }
  // configure command line parameters
  const optionals = []
  const requireds = []
  if (config.storage.testnet) {
    optionals.push('--testnet')
  }
  if (config.storage.log_level) {
    optionals.push('--log-level', config.storage.log_level)
  }
  if (config.storage.data_dir) {
    optionals.push('--data-dir', config.storage.data_dir)
  }
  // BLOCKCHAIN communication
  if (configUtil.isStorageBinary21X(config) || configUtil.isStorageBinary22X(config)  || configUtil.isStorageBinary23X(config)) {
    if (config.storage.oxend_rpc_socket) {
      optionals.push('--oxend-rpc', config.storage.oxend_rpc_socket)
    }
    else {
      if (config.storage.oxend_rpc_ip) {
        optionals.push('--oxend-rpc-ip', config.storage.oxend_rpc_ip)
      }
      if (config.storage.oxend_rpc_port) {
        optionals.push('--oxend-rpc-port', config.storage.oxend_rpc_port)
      }
    }
  } else {
    if (config.storage.lokid_rpc_port) {
      optionals.push('--lokid-rpc-port', config.storage.lokid_rpc_port)
    }
  }
  // key/lmq-port
  if (!configUtil.isStorageBinary2X(config)) {
    // 1.0.x
    // this was required, we'll stop supporting it in 2x (tho 2.0 still accepts it)
    if (config.storage.lokid_key) {
      optionals.push('--lokid-key', config.storage.lokid_key)
    }
  } else {
    // 2.x
    requireds.push('--lmq-port', config.storage.lmq_port)
  }
  if (config.storage.force_start) {
    optionals.push('--force-start')
  }
  console.log('STORAGE: Launching', config.storage.binary_path, [config.storage.ip, config.storage.port, ...requireds, ...optionals].join(' '))
  /*
  // ip and port must be first
  var p1 = '"' + (['ulimit', '-n', '16384 ; ', config.storage.binary_path, config.storage.ip, config.storage.port, ...requireds, ...optionals].join(' ')) + '"'
  console.log('p1', p1)
  storageServer = spawn('/bin/bash', ['-c', p1], {
  })
  */
  storageServer = spawn(config.storage.binary_path, [config.storage.ip, config.storage.port, ...requireds, ...optionals])

  //storageServer = spawn('/usr/bin/valgrind', ['--leak-check=yes', config.storage.binary_path, config.storage.ip, config.storage.port, '--log-level=trace', ...optionals])
  // , { stdio: 'inherit' })

  //console.log('storageServer', storageServer)
  if (!storageServer.stdout || !storageServer.pid) {
    console.error('storageServer failed?')
    if (cb) cb(false)
    return
  }
  storageServer.killed = false
  storageServer.startTime = Date.now()
  storageServer.blockchainFailures = {}
  lib.savePids(config, args, loki_daemon, lokinet, storageServer)

  function getPidLimit(pid) {
    // linux only
    try {
      const currentLimit = execSync(`grep 'open file' /proc/${pid}/limits`)
      const lines = currentLimit.toString().split('\n')
      const parts = lines[0].split(/\s{2,}/)
      //console.log('lines', lines)
      //console.log('parts', parts)
      return [ parts[1], parts[2]]
    } catch(e) {
      console.error('getPidLimit error', e.code, e.message)
      return [ 0, 0 ]
    }
  }


  if (configUtil.isStorageBinary2X(config)) {
    var limits = getPidLimit(storageServer.pid)
    if (limits[0] < 16384 || limits[1] < 16384) {
      console.error('')
      var ourlimits = getPidLimit(process.pid)
      console.warn('')
      console.warn('node limits', ourlimits, 'oxen-storage limits', limits)
      console.warn('There maybe not enough file descriptors to run oxen-storage, you may want to look at increasing it')
      console.warn('')
      // console.error('Not enough file descriptors to run loki-storage, shutting down')
      // console.error("put LimitNOFILE=16384 in your [Service] section of /etc/systemd/system/lokid.service")
      // shutdown_everything()
    }
  }

  //var fixResult = execSync(`prlimit --pid ${storageServer.pid} --nofile=16384:16384`)
  //var fixResult = execSync(`python3 -c "import resource; resource.prlimit(${storageServer.pid}, resource.RLIMIT_NOFILE, (2048, 16384))"`)
  //console.log('fixResult', fixResult.toString())

  //console.log('after', getPidLimit())

  // copy the output to stdout
  let storageServer_version = 'unknown'
  let stdout = '', stderr = '', collectData = true
  let probablySyncing = false
  storageServer.stdout
    .on('data', (data) => {
      const logLinesStr = data.toString('utf8').trim()
      if (collectData) {
        const lines = logLinesStr.split(/\n/)
        for(let i in lines) {
          const tline = lines[i].trim()
          if (tline.match('Loki Storage Server v')) {
            const parts = tline.split('Loki Storage Server v')
            storageServer_version = parts[1]
          }
          if (tline.match('git commit hash: ')) {
            const parts = tline.split('git commit hash: ')
            fs.writeFileSync(config.launcher.var_path + '/storageServer.version', storageServer_version+"\n"+parts[1])
          }
          if (tline.match(/pubkey_x25519_hex is missing from sn info/)) {
            // it's be nice to know lokid was syncing
            // but from the loki-storage logs doesn't look like it's possible to tell
            // save some logging space
            continue
          }
          if (storageLogging) console.log(`STORAGE(Start): ${tline}`)
        }
        stdout += data
      } else {


        const lines = logLinesStr.split(/\n/)
        for(let i in lines) {
          const str = lines[i].trim()
          let outputError = true

          // all that don't need storageServer set

          // could be testing a remote node
          if (str.match(/Could not report node status: bad json in response/)) {
          } else if (str.match(/Could not report node status/)) {
          }
          if (str.match(/Empty body on Lokid report node status/)) {
          }
          // end remote node

          if (!storageServer) {
            if (storageLogging && outputError) console.log(`STORAGE: ${logLinesStr}`)
            console.log('storageServer is unset, yet getting output', logLinesStr)
            continue
          }
          // all that need storageServer set

          // blockchain test
          if (str.match(/Could not send blockchain request to Lokid/)) {
            if (storageLogging) console.log(`STORAGE: blockchain test failure`)
            storageServer.blockchainFailures.last_blockchain_test = Date.now()
            //communicate this out
            lib.savePids(config, args, loki_daemon, lokinet, storageServer)
          }
          // blockchain ping
          if (str.match(/Empty body on Lokid ping/) || str.match(/Could not ping Lokid. Status: {}/) ||
              str.match(/Could not ping Lokid: bad json in response/) || str.match(/Could not ping Lokid/)) {
            if (storageLogging) console.log(`STORAGE: blockchain ping failure`)
            storageServer.blockchainFailures.last_blockchain_ping = Date.now()
            //communicate this out
            lib.savePids(config, args, loki_daemon, lokinet, storageServer)
          }
          // probably syncing
          if (str.match(/Bad lokid rpc response: invalid json fields/)) {
            probablySyncing = true
          }

          if (str.match(/pubkey_x25519_hex is missing from sn info/)) {
            // it's be nice to know lokid was syncing
            // but from the loki-storage logs doesn't look like it's possible to tell
            // save some logging space
            outputError = false // hide these
            continue // no need to output it again
          }

          // swarm_tick communication error
          // but happens when lokid is syncing, so we can't restart lokid
          if (str.match(/Exception caught on swarm update: Failed to parse swarm update/)) {
            if (probablySyncing) {
              if (storageLogging) console.log(`STORAGE: blockchain comms failure, probably syncing`)
              outputError = false // hide these
              continue // no need to output it again
            } else {
              if (storageLogging) console.log(`STORAGE: blockchain tick failure`)
              storageServer.blockchainFailures.last_blockchain_tick = Date.now()
              //communicate this out
              lib.savePids(config, args, loki_daemon, lokinet, storageServer)
            }
          } else if (str.match(/Exception caught on swarm update/)) {
            if (storageLogging) console.log(`STORAGE: blockchain tick failure. Maybe syncing? ${probablySyncing}`)
            storageServer.blockchainFailures.last_blockchain_tick = Date.now()
            //communicate this out
            lib.savePids(config, args, loki_daemon, lokinet, storageServer)
          }
          // swarm_tick communication error
          if (str.match(/Failed to contact local Lokid/)) {
            var ts = Date.now()
            // skip if lokid is restarting...
            if (requestBlockchainRestartLock) continue
            lastLokidContactFailures.push(ts)
            if (lastLokidContactFailures.length > 5) {
              lastLokidContactFailures.splice(-5)
            }
            // exitRequested doesn't need to double up on the output in interactive-debug
            if (!shuttingDown && !exitRequested) {
              console.log('STORAGE: can not contact blockchain, failure count', lastLokidContactFailures.length, 'first', parseInt((ts - lastLokidContactFailures[0]) / 1000) + 's ago')
            }
            // if the oldest one is not more than 180s ago
            // it's not every 36s
            // a user provided a ss where there was 300s between the 1st and the 2nd
            // 0,334,374.469.730,784
            // where it should have been restarted, so 5 in 15 mins will be our new tune
            // was 11 * 36
            if (lastLokidContactFailures.length == 5 && ts - lastLokidContactFailures[0] < 900 * 1000) {
              // now it's a race, between us detect lokid shutting down
              // and us trying to restart it...
              // mainly will help deadlocks
              if (!exitRequested) { // user typed exit
                // don't keep trying to restart it
                // lokid will be done for 30s if it's being restarted.
                //if (loki_daemon && !loki_daemon.killed) {
                  console.log('we should restart lokid');
                  requestBlockchainRestart(config);
                //}
              }
            }
            if (storageLogging) console.log(`STORAGE: blockchain tick contact failure`)
            storageServer.blockchainFailures.last_blockchain_tick = Date.now()
            //communicate this out
            lib.savePids(config, args, loki_daemon, lokinet, storageServer)
          }
          if (storageLogging && outputError) console.log(`STORAGE: ${logLinesStr}`)
        }
      }
      //if (storageLogging) console.log(`STORAGE: ${logLinesStr}`)
    })
    .on('error', (err) => {
      console.error(`Storage Server stdout error: ${err.toString('utf8').trim()}`)
    })

  storageServer.stderr
    .on('data', (err) => {
      if (storageLogging) console.log(`Storage Server error: ${err.toString('utf8').trim()}`)
    })
    .on('error', (err) => {
      console.error(`Storage Server stderr error: ${err.toString('utf8').trim()}`)
    })

  function watchdogCheck() {
    // console.log('STORAGE: checking for deadlock')
    lib.runStorageRPCTest(lokinet, config, function(data) {
      if (data === undefined) {
        console.log('STORAGE: RPC server not responding, restarting storage server')
        shutdown_storage()
      }
    })
  }

  function startupComplete() {
    console.log('STORAGE: Turning off storage server start up watcher, starting watchdog')
    collectData = false
    stdout = ''
    stderr = ''
    clearInterval(memoryWatcher)
    memoryWatcher = null
    watchdog = setInterval(watchdogCheck, 10 * 60 * 1000)
  }

  // don't hold up the exit too much
  let watchdog = null
  // startupComplete will stop us
  let memoryWatcher = setInterval(function() {
    lib.runStorageRPCTest(lokinet, config, function(data) {
      // start complete is complete when the RPC responds
      if (data !== undefined) {
        startupComplete()
      }
    })
  }, 10 * 1000)

  storageServer.on('error', (err) => {
    console.error('STORAGEP_ERR:', JSON.stringify(err))
  })

  storageServer.on('close', (code, signal) => {
    if (memoryWatcher !== null) clearInterval(memoryWatcher)
    if (watchdog !== null) clearInterval(watchdog)
    console.log(`StorageServer process exited with code ${code}/${signal} after`, (Date.now() - storageServer.startTime)+'ms')
    storageServer.killed = true
    if (code == 1) {
      // these seem to be empty
      console.log(stdout, 'stderr', stderr)
      // also now can be a storage server crash
      // also can mean bad params passed in
      // we can use a port to check to make sure...
      console.log('')
      console.warn('StorageServer bind port could be in use, please check to make sure.', config.storage.binary_path, 'is not already running on port', config.storage.port)
      // we could want to issue one kill just to make sure
      // however since we don't know the pid, we won't know if it's ours
      // or meant be running by another copy of the launcher
      // at least any launcher copies will be restarted
      //
      // we could exit, or prevent a restart
      storageServer = null // it's already dead
      // we can no longer shutdown here, if storage server crashes, we do need to restart it...
      //return shutdown_everything()
    }
    // code null means clean shutdown
    if (!shuttingDown) {
      // wait 30s
      setTimeout(function() {
        console.log('loki_daemon is still running, restarting storageServer.')
        launcherStorageServer(config, args)
      }, 30 * 1000)
    }
  })

  /*
  function flushOutput() {
    if (!storageServer || storageServer.killed) {
      console.log('storageServer flushOutput lost handle, stopping flushing')
      return
    }
    storageServer.stdin.write("\n")
    // schedule next flush
    storageServer.outputFlushTimer = setTimeout(flushOutput, 1000)
  }
  console.log('starting log flusher for storageServer')
  storageServer.outputFlushTimer = setTimeout(flushOutput, 1000)
  */

  if (cb) cb(true)
}

let waitForLokiKeyTimer = null
// as of 6.x storage and network not get their key via rpc call
// and this isn't called unless the lokid is pre 6.x
function waitForLokiKey(config, timeout, start, cb) {
  if (start === undefined) start = Date.now()
  if (config.storage.lokid_key === undefined) {
    if (config.storage.enabled) {
      console.error('Storage lokid_key is not configured')
      process.exit(1)
    }
    cb(true)
    return
  }
  console.log('DAEMON: Checking on', config.storage.lokid_key)
  if (!fs.existsSync(config.storage.lokid_key)) {
    if (timeout && (Date.now - start > timeout)) {
      cb(false)
      return
    }
    waitForLokiKeyTimer = setTimeout(function() {
      waitForLokiKey(config, timeout, start, cb)
    }, 1000)
    return
  }
  waitForLokiKeyTimer = null
  cb(true)
}

// FIXME: make sure blockchain.rpc port is bound before starting...
let rpcUpTimer = null
function startStorageServer(config, args, cb) {
  //console.log('trying to get IP information about lokinet')
  // does this belong here?
  if (config.storage.enabled) {
    if (config.storage.data_dir !== undefined) {
      if (!fs.existsSync(config.storage.data_dir)) {
        lokinet.mkDirByPathSync(config.storage.data_dir)
      }
    }
  }

  function checkRpcUp(cb) {
    if (shuttingDown) {
      //if (cb) cb()
      console.log('STORAGE: Not going to start storageServer, shutting down.')
      return
    }
    // runStorageRPCTest(lokinet, config, function(data) {
    //   if (data !== undefined) {
    //     return cb()
    //   }
    //})
    lokinet.portIsFree(config.blockchain.rpc_ip, config.blockchain.rpc_port, function(portFree) {
      if (!portFree) {
        cb()
        return
      }
      rpcUpTimer = setTimeout(function() {
        checkRpcUp(cb)
      }, 5 * 1000)
    })
  }

  checkRpcUp(function() {
    //console.log('checkRpcUp cb')
    config.storage.ip = '0.0.0.0';
    if (config.network.enabled) {
      lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      launcherStorageServer(config, args, cb)
      /*
      lokinet.getLokiNetIP(function (ip) {
        // lokinet has started, save config and various process pid
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
        if (ip) {
          console.log('DAEMON: Starting storageServer on', ip)
          config.storage.ip = ip
          launcherStorageServer(config, args, cb)
        } else {
          console.error('DAEMON: Sorry cant detect our lokinet IP:', ip)
          if (cb) cb(false)
          //shutdown_everything()
        }
      })
      */
    } else if (config.storage.enabled) {
      /*
      lokinet.getNetworkIP(function(err, localIP) {
        console.log('DAEMON: Starting storageServer on', localIP)
        // we can only ever bind to the local IP
        config.storage.ip = localIP
        launcherStorageServer(config, args, cb)
      })
      */
      launcherStorageServer(config, args, cb)
    } else {
      console.log('StorageServer is not enabled.')
    }
  })
}

function startLokinet(config, args, cb) {
  //console.log('DAEMON: startLokinet')
  // we no longer need to wait for LokiKey before starting network/storage
  // waitForLokiKey(config, timeout, start, cb)
  if (configUtil.isBlockchainBinary3X(config) || configUtil.isBlockchainBinary4Xor5X(config)) {
    // 3.x-5.x, we need the key
    if (config.storage.lokid_key === undefined) {
      if (config.storage.enabled) {
        console.error('Storage server enabled but no key location given.')
        process.exit(1)
      }
      if (config.network.enabled) {
        lokinet.startServiceNode(config, function () {
          startStorageServer(config, args, cb)
        })
      } else {
        //console.log('no storage key configured')
        if (cb) cb(true)
      }
      return
    }
    console.log('DAEMON: Waiting for loki key at', config.storage.lokid_key)
    waitForLokiKey(config, 30 * 1000, undefined, function(haveKey) {
      if (!haveKey) {
        console.error('DAEMON: Timeout waiting for loki key.')
        // FIXME: what do?
        return
      }
      console.log('DAEMON: Got Loki key!')
      if (config.network.enabled) {
        lokinet.startServiceNode(config, function () {
          startStorageServer(config, args, cb)
        })
      } else {
        if (config.storage.enabled) {
          startStorageServer(config, args, cb)
        } else {
          if (cb) cb(true)
        }
      }
    })
  } else {
    // 6.x+, not key needed
    if (config.network.enabled) {
      config.network.onStart = function(config, instance, lokinetProc) {
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      config.network.onStop = function(config, instance, lokinetProc) {
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      lokinet.startServiceNode(config, function () {
        lokinetPidwatcher = setInterval(function() {
          // read pids.json
          var pids = lib.getPids(config)
          var lokinetProc = lokinet.isRunning()
          if (lokinetProc) {
            // console.log('lokinet pid is', lokinetProc.pid, 'json is', pids.lokinet)
            if (lokinetProc.pid != pids.lokinet) {
              console.warn('Updating lokinet PID')
              lib.savePids(config, args, loki_daemon, lokinet, storageServer)
            }
          } else {
            console.log('no lokinet pid', lokinet)
          }
        }, 30 * 1000)
        startStorageServer(config, args, cb)
      })
    } else {
      if (config.storage.enabled) {
        startStorageServer(config, args, cb)
      } else {
        if (cb) cb(true)
      }
    }
  }
}

function startLauncherDaemon(config, interactive, entryPoint, args, debug, cb) {
  /*
  try {
    process.seteuid('rtharp')
    console.log(`New uid: ${process.geteuid()}`)
  } catch(err) {
    console.log(`Failed to set uid: ${err}`)
  }
  */
  function doStart() {
    function startBackgroundCode() {
      // backgrounded or launched in interactive mode
      // strip any launcher-specific params we shouldn't need any more
      for(var i in args) {
        var arg = args[i]
        if (arg == '--skip-storage-server-port-check') {
          args.splice(i, 1) // remove this option
        } else
        if (arg == '--ignore-storage-server-port-check') {
          args.splice(i, 1) // remove this option
        }
      }
      //console.log('backgrounded or launched in interactive mode')
      g_config = config
      lib.setStartupLock(config)
      cb()
    }

    // see if we need to detach
    //console.log('interactive', interactive)
    if (!interactive) {
      //console.log('fork check', process.env.__daemon)
      if (!process.env.__daemon || config.launcher.cimode) {
        //console.log('cimode', config.launcher.cimode)
        let child
        if (!config.launcher.cimode) {
          // first run
          process.env.__daemon = true
          // spawn as child
          const cp_opt = {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
            cwd: process.cwd(),
            detached: true
          }
          // this doesn't work like this...
          //args.push('1>', 'log.out', '2>', 'err.out')
          console.log('Launching', process.execPath, entryPoint, 'daemon-start', args)
          child = spawn(process.execPath, [entryPoint, 'daemon-start', '--skip-storage-server-port-check'].concat(args), cp_opt)
          //console.log('child', child)
          if (!child) {
            console.error('Could not spawn detached process')
            process.exit(1)
          }
          // won't accumulate cause we're quitting...
          var stdout = '', stderr = ''
          child.stdout.on('data', (data) => {
            //if (debug) console.log(data.toString())
            stdout += data.toString()
          })
          child.stderr.on('data', (data) => {
            //if (debug) console.error(data.toString())
            stderr += data.toString()
          })
          //var launcherHasExited = false
          function crashHandler(code, signal) {
            console.log('Background launcher died with', code, signal, stdout, stderr)
            //launcherHasExited = true
            process.exit(1)
          }
          child.on('close', crashHandler)
        }
        // required so we can exit
        var startTime = Date.now()
        console.log('Waiting on start up confirmation...')
        function areWeRunningYet() {
          var diff = Date.now() - startTime
          // , process.pid
          console.log('Checking start up progress...')
          lib.getLauncherStatus(config, lokinet, 'waiting...', function(running, checklist) {
            var nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
            if (nodeVer >= 10) {
              console.table(checklist)
            } else {
              console.log(checklist)
            }
            var pids = lib.getPids(config) // need to get the config
            // blockchain rpc is now required for SN

            var blockchainIsFine = pids.runningConfig && pids.runningConfig.blockchain && checklist.blockchain_rpc !== 'waiting...'
            // donish conditions
            if (running.launcher && running.lokid && checklist.socketWorks !== 'waiting...' &&
                  pids.runningConfig && blockchainIsFine
                ) {
              if (checklist.blockchain_status && checklist.blockchain_status.split(/ /).includes('syncingChain')) {
                console.log('Blockchain is syncing, likely will be a long time until storage/network will be ready, check status periodically')
                if (child) child.removeListener('close', crashHandler)
                process.exit()
              }
              var networkIsFine = (!pids.runningConfig) || (!pids.runningConfig.network) || (!pids.runningConfig.network.enabled) || (checklist.network !== 'waiting...')
              if (running.launcher && running.lokid && checklist.socketWorks !== 'waiting...' &&
                    pids.runningConfig && blockchainIsFine && networkIsFine &&
                    checklist.storageServer !== 'waiting...' && checklist.storage_rpc !== 'waiting...'
                  ) {
                console.log('Start up successful!')
                if (child) child.removeListener('close', crashHandler)
                process.exit()
              }
            }
            // if storage is enabled but not running, wait for it
            if (pids.runningConfig && pids.runningConfig.storage.enabled && checklist.storageServer === 'waiting...' && blockchainIsFine && networkIsFine) {
              // give it 30s more if everything else is fine... for what?
              if (diff > 1.5  * 60 * 1000) {
                console.log('Storage server start up timeout, likely failed.')
                process.exit(1)
              }
              setTimeout(areWeRunningYet, 5000)
              return
            }
            if (pids.runningConfig && pids.runningConfig.storage.enabled && checklist.storage_rpc === 'waiting...' && blockchainIsFine && networkIsFine) {
              // give it 15s more if everything else is fine... for it's DH generation
              if (diff > 1.75 * 60 * 1000) {
                console.log('Storage server rpc timeout, likely DH generation is taking long...')
                process.exit(0)
              }
              setTimeout(areWeRunningYet, 5000)
              return
            }
            if (diff > 1   * 60 * 1000) {
              console.log('Start up timeout, likely failed.')
              process.exit(1)
            }
            //if (!launcherHasExited) {
            setTimeout(areWeRunningYet, 5000)
            //}
          })
        }
        setTimeout(areWeRunningYet, 5000)
        if (child) child.unref()
        if (config.launcher.cimode) {
          console.log('continuing foreground startup')
          startBackgroundCode()
        }
        return
      }
      // no one sees these
      //console.log('backgrounded')
    } else {
      // interactive is mainly for lokid
      if (!debug) {
        lokinet.disableLogging(true)
        storageLogging = false
      }
    }

    startBackgroundCode()
  }
  function testOpenPorts() {
    // move deterministic behavior than letting the OS decide
    console.log('Starting verification phase')
    const testingHostname = 'testing.hesiod.network'
    console.log('Downloading test servers from', testingHostname)
    dns.resolve4(testingHostname, function(err, addresses) {
      if (err) console.error('dnsLookup err', err)
      //console.log('addresses', addresses)
      function tryAndConnect() {
        var idx = parseInt(Math.random() * addresses.length)
        var server = addresses[idx]
        /*
        dns.resolvePtr(server, function(err, names) {
          if (err) console.error('dnsPtrLookup err', err)
          if (names.length) console.log('trying to connect to', names[0])
        })
        */
        console.log('Trying to connect to', server)
        addresses.splice(idx, 1) // remove it
        networkTest.createClient(server, 3000, async function(client) {
          //console.log('client', client)
          if (debug) console.debug('got createClient cb')
          if (client === false) {
            if (!addresses.length) {
              console.warn('We could not connect to ANY testing server, you may want to check your internet connection and DNS settings')
              /*
              setTimeout(function() {
                testOpenPorts()
              }, 30 * 1000)
              */
              console.log('Verification phase complete')
              doStart()
            } else {
              // retry with a different server
              tryAndConnect()
            }
            return
          }

          // select your tests
          const ourTests = []
          if (!configUtil.isBlockchainBinary3X(config) && !configUtil.isBlockchainBinary4Xor5X(config)) {
            ourTests.push({
              name: 'blockchain quorumnet',
              shortName: 'OpenQuorumNetPort',
              type: 'tcp',
              outgoing: false,
              recommended: false,
              port: config.blockchain.qun_port
            },
            {
              name: 'storage server',
              shortName: 'OpenStoragePort',
              type: 'tcp',
              outgoing: false,
              recommended: false,
              port: config.storage.port
            })
            if (configUtil.isBlockchainBinary7X(config)) {
              ourTests.push({
                name: 'storage server LMQ',
                shortName: 'OpenStorageLMQPort',
                type: 'tcp',
                outgoing: false,
                recommended: false,
                port: config.storage.lmq_port
              })
            }
            if (config.network.enabled) {
              ourTests.push({
                name: 'network incoming',
                shortName: 'OpenNetworkRecvPort',
                type: 'udp',
                outgoing: false,
                recommended: false,
                port: config.network.public_port
              },
              {
                name: 'network outgoing',
                shortName: 'OpenNetworkSendPort',
                type: 'udp',
                outgoing: true,
                recommended: false,
                port: config.network.public_port
              })
            }
          } else {
            if (config.storage.enabled) {
              ourTests.push({
                name: 'storage server',
                shortName: 'OpenStoragePort',
                type: 'tcp',
                outgoing: false,
                recommended: false,
                port: config.storage.port
              })
            }
          }

          function runTest(test) {
            return new Promise((resolve, rej) => {
              console.log('Starting open port check on configured', test.name, (test.type === 'tcp' ? 'TCP':'UDP'), 'port:', test.port)
              p2 = debug
              testName = 'startTestingServer'
              if (test.type === 'udp') {
                if (test.outgoing) {
                  testName = 'testUDPSendPort'
                  p2 = 1090
                } else {
                  testName = 'startUDPRecvTestingServer'
                }
              }
              client[testName](test.port, p2, function(results, port) {
                if (results != 'good') {
                  if (results === 'inuse') {
                    console.error((test.type === 'udp' ? 'UDP' : 'TCP') + ' PORT ' + port +
                      ' ' + (test.outgoing?'OUTGOING':'INCOMING') +
                      ' is already in use, please make sure nothing is using the port before trying again')
                  } else {
                    let wasTimeout = false
                    if (port === 'ETIMEDOUT') {
                      port = test.port
                      wasTimeout = true
                    }
                    console.error('WE COULD NOT VERIFY THAT YOU HAVE ' +
                      (test.type === 'udp' ? 'UDP' : 'TCP') + ' PORT ' + port +
                      ' ' + (test.outgoing?'OUTGOING':'INCOMING') +
                      ', OPEN ON YOUR FIREWALL/ROUTER, this is ' + (test.recommended?'recommended':'required') + ' to run a service node')
                    if (wasTimeout) {
                      console.warn('There was a timeout, please retry')
                    }
                  }

                  for(var i in args) {
                    var arg = args[i]
                    if (arg == '--ignore-storage-server-port-check') {
                      client.disconnect()
                      console.log('verification phase complete (ignoring checks)')
                      args.splice(i, 1) // remove this option
                      doStart()
                      return
                    }
                  }
                  process.exit(1)
                }
                resolve()
              })
            })
          }

          for(test of ourTests) {
            await runTest(test)
          }
          console.log('verification phase complete.')
          client.disconnect()
          doStart()

        }) // end createClient
      } // end func tryAndConnect
      tryAndConnect()
    }) // end resolve
  }
  if (config.storage.enabled || config.network.enabled) {
    for(var i in args) {
      var arg = args[i]
      if (arg == '--skip-storage-server-port-check') {
        args.splice(i, 1) // remove this option
        doStart()
        return
      }
    }
    testOpenPorts()
  } else {
    doStart()
  }
}

function arrayHasClOption(arr, option) {
  return arr.some(item => {
    //console.log('item', item)
    return (''+item).match(option)
  })
}

// compile config into CLI arguments
// only needs to be ran when config changes
function configureLokid(config, args) {
  //console.log('configureLokid', args)
  var lokid_options = []
  // this matches --service-node-...
  if (!arrayHasClOption(args, /^--service-node$/)) {
    //console.log('adding --SN')
    lokid_options.push('--service-node')
  }

  // 8.1.3+
  if (configUtil.blockchainBinaryAfter813(config)) {
    // don't pass rpc-bind-ip or rpc-bind-port

    // if ip is not localhost, pass it to lokid
    if (config.blockchain.rpc_ip && config.blockchain.rpc_ip !== '127.0.0.1') {
      if (!arrayHasClOption(args, '--rpc-public') && !arrayHasClOption(args, '--rpc-admin')) {
        lokid_options.push('--rpc-public=' + config.blockchain.rpc_ip + ':' + config.blockchain.rpc_port)
      }
      if (!arrayHasClOption(args, '--confirm-external-bind')) {
        lokid_options.push('--confirm-external-bind')
      }
    } else {
      // rpc_ip is not set OR rpc_ip is 127.0.0.1
      // if not using rpc-public, using rpc-admin

      // make sure it's not overriddened by xmr cli args
      if (!arrayHasClOption(args, '--rpc-public') && !arrayHasClOption(args, '--rpc-admin') &&
          !configUtil.blockchainIsDefaultRPCPort(config)) {
        lokid_options.push('--rpc-admin=' + config.blockchain.rpc_ip + ':' + config.blockchain.rpc_port)
      }
    }
  } else {
    // if ip is not localhost, pass it to lokid
    if (config.blockchain.rpc_ip && config.blockchain.rpc_ip != '127.0.0.1') {
      if (!arrayHasClOption(args, '--rpc-bind-ip')) {
        lokid_options.push('--rpc-bind-ip=' + config.blockchain.rpc_ip)
      }
      if (!arrayHasClOption(args, '--confirm-external-bind')) {
        lokid_options.push('--confirm-external-bind')
      }
    }
    if (config.blockchain.rpc_port && !arrayHasClOption(args, '--rpc-bind-port') &&
        !configUtil.blockchainIsDefaultRPCPort(config)) {
      lokid_options.push('--rpc-bind-port=' + config.blockchain.rpc_port)
    }
  }
  if (config.blockchain.p2p_ip && config.blockchain.p2p_ip !== '0.0.0.0'
      && !arrayHasClOption(args, '--p2p-bind-ip')) {
    lokid_options.push('--p2p-bind-ip=' + config.blockchain.p2p_ip)
  }
  if (config.blockchain.rpc_pass && !arrayHasClOption(args, '--rpc-login')) {
    lokid_options.push('--rpc-login='+config.blockchain.rpc_user+':'+config.blockchain.rpc_pass)
  }
  if (!config.launcher.interactive) {
    // we handle the detach, we don't need to detach lokid from us
    // we need this now to keep a console open
    //lokid_options.push('--non-interactive')
    // if we leave this disabled, we won't be able to see startup errors
    // only really good for debugging lokid stuffs
    //lokinet.disableLogging()
  }
  if (config.blockchain.zmq_port && !arrayHasClOption(args, '--zmq-bind-port')) {
    lokid_options.push('--zmq-rpc-bind-port=' + config.blockchain.zmq_port)
  }
  if (config.blockchain.p2p_port && !arrayHasClOption(args, '--p2p-bind-port')
    && !configUtil.blockchainIsDefaultP2PPort(config)) {
    lokid_options.push('--p2p-bind-port=' + config.blockchain.p2p_port)
  }
  if (config.blockchain.data_dir&& !arrayHasClOption(args, '--data-dir')) {
    lokid_options.push('--data-dir=' + config.blockchain.data_dir)
  }

  // net selection at the very end because we may need to override a lot of things
  // but not before the dedupe
  if (!arrayHasClOption(args, '--testnet') && !arrayHasClOption(args, '--stagenet')) {
    if (config.blockchain.network == "test") {
      lokid_options.push('--testnet')
    } else
    if (config.blockchain.network == "demo") {
      lokid_options.push('--testnet')
      lokid_options.push('--add-priority-node=116.203.126.14')
    } else
    if (config.blockchain.network == "staging") {
      lokid_options.push('--stagenet')
    }
  }

  if (!arrayHasClOption(args, '--max-concurrency')) {
    // logical core count
    let cpuCount = os.cpus().length
    if (fs.existsSync('/sys/devices/system/cpu/online')) {
      // 0-63
      const cpuData = fs.readFileSync('/sys/devices/system/cpu/online')
      cpuCount = parseInt(cpuData.toString().replace(/^0-/, '')) + 1
    }
    console.log('CPU Count', cpuCount)
    // getconf _NPROCESSORS_ONLN
    // /sys/devices/system/cpu/online
    if (cpuCount > 16) {
        lokid_options.push('--max-concurrency=16')
    }
  }

  // not 3.x
  if (!configUtil.isBlockchainBinary3X(config)) {
    // 4.x+
    if (!arrayHasClOption(args, '--storage-server-port')) {
      // is always required in snode mode, there is no default
      lokid_options.push('--storage-server-port', config.storage.port)
    }
    // make sure not passed in xmrOptions
    //console.log('args', args)
    if (!arrayHasClOption(args, '--service-node-public-ip')) {
      //console.log('adding', config.launcher.publicIPv4)
      lokid_options.push('--service-node-public-ip', config.launcher.publicIPv4)
    }
  } else {
    console.log('3.x blockchain block binary detected')
  }
  // 6.x+ (not 3,4,5)
  if (!configUtil.isBlockchainBinary3X(config) &&
      !configUtil.isBlockchainBinary4Xor5X(config) && config.blockchain.qun_port &&
      !arrayHasClOption(args, '--quorumnet-port') && !configUtil.blockchainIsDefaultQunPort(config)) {
    lokid_options.push('--quorumnet-port=' + config.blockchain.qun_port)
  }

  // copy CLI options to lokid
  var normalizeArgs = []
  function normalizeSet(key, value) {
    //console.log('set?', key, ':', value)
    // remove any previous setting
    normalizeArgs = normalizeArgs.filter(item => {
      // get key name
      var parts = item.replace(/^--/, '').split(/=/)
      var newSet = key !== parts.shift()
      if (!newSet) {
        console.warn('Overriding earlier option of', item)
      }
      return newSet
    })
    // always add the new setting
    normalizeArgs.push('--' + key + '=' + value)
  }

  // what if we normalize them into an array
  var last = null
  var all_options = lokid_options.concat(args)
  //console.log('all_options', all_options)
  for (var i in all_options) {
    // should we prevent --non-interactive?
    // probably not, if they want to run it that way, why not support it?

    // FIXME: we just need to adjust internal config
    // do we?
    var arg = '' + all_options[i]
    //console.log('arg', arg)

    if (arg.match(/^--/)) {
      // -- part
      if (last != null) {
        // if last was --!=
        // now removeDashes is definitely not a value
        // codify no value...
        normalizeSet(last, '__REMOVE_ME__')
        last = null
      }
      var removeDashes = arg.replace(/^--/, '')
      if (arg.match(/=/)) {
        var parts = removeDashes.split(/=/)
        var key = parts.shift()
        var value = parts.join('=')
        normalizeSet(key, value)
        last = null
      } else {
        // read next to make a decision
        last = removeDashes
      }
    } else {
      // hack to allow equal to be optional..
      if (last !== null) {
        // should stitch together last = arg
        normalizeSet(last, arg)
      }
      last = null
    }
  }
  //console.log('last', last)
  // flush the last if it's --testnet
  if (last !== null) {
    normalizeSet(last, '__REMOVE_ME__')
  }
  // and process them as such...
  //console.log('normalized args', normalizeArgs)
  lokid_options = normalizeArgs.map(str => str.replace('=__REMOVE_ME__', ''))
  // well we used 2 buckets before
  // so we didn't collide on current item
  // if we use lokid_options then we're back to the parse problem...

  //console.log('final options', lokid_options)

  return {
    lokid_options: lokid_options,
  }
}

var loki_daemon
var inPrepareReg = false
var savePidConfig = {}
var lastLokiStorageContactFailures = []
var loadingSubsystems = false
var syncingChain = false

function launchLokid(binary_path, lokid_options, interactive, config, args, cb) {
  if (shuttingDown) {
    //if (cb) cb()
    console.log('BLOCKCHAIN: Not going to start lokid, shutting down.')
    return
  }

  if (loki_daemon) {
    if (loki_daemon.killed) {
      // only should be displayed on a restart
      console.log('BLOCKCHAIN: there\'s already a killed loki_daemon set')
      // seems to be ok to restart...
    } else {
      console.log('BLOCKCHAIN: there\'s already a running loki_daemon set')
      // maybe we should stop start up
      // so we don't double claim ports and shutdown everything
      // we should delay so we don't lose a handle on the running loki_daemon
      // otherwise we can never kill/manage it
    }
  }

  // hijack STDIN but not OUT/ERR
  //console.log('launchLokid - interactive?', interactive)
  if (interactive) {
    // don't hijack stdout, so prepare_registration works
    console.log('BLOCKCHAIN: (interactive mode) Launching', binary_path, lokid_options.join(' '))
    loki_daemon = spawn(binary_path, lokid_options, {
      stdio: ['pipe', 'inherit', 'inherit'],
      //shell: true
    })
  } else {
    // allow us to hijack stdout
    console.log('BLOCKCHAIN: Launching', binary_path, lokid_options.join(' '))
    loki_daemon = spawn(binary_path, lokid_options)
  }
  if (!loki_daemon) {
    console.error('BLOCKCHAIN: Failed to start lokid, exiting...')
    shutdown_everything()
    return
  }

  loki_daemon.on('error', (err) => {
    console.error('BLOCKCHAINP_ERR:', JSON.stringify(err))
  })

  loki_daemon.startTime = Date.now()
  loki_daemon.startedOptions = lokid_options
  loki_daemon.storageFailures = {

  }
  loki_daemon.status = {
  }
  savePidConfig = {
    config: config,
    args: args,
  }
  lib.savePids(config, args, loki_daemon, lokinet, storageServer)

  if (!interactive && !config.blockchain.quiet) {
    // why is the banner held back until we connect!?
    loki_daemon.stdout.on('data', (data) => {
      console.log(`blockchainRAW: ${data}`)

      var str = data.toString()

      // downgrade lokid
      // E Failed to parse service node data from blob: Invalid integer or enum value during deserialization
      if (str.match(/E Failed to parse service node data from blob: Invalid integer or enum value during deserialization/)) {
        console.log('blockchain downgrade?')
      }

      // lns.db recreation
      // 2020-09-28 01:47:40.663	I Loading blocks into loki subsystems, scanning blockchain from height: 101250 to: 615676 (snl: 101250, lns: 496969)
      if (str.match(/subsystems, scanning blockchain from height/)) {
        console.log('blockchain subsystem loading')
        loadingSubsystems = true
        loki_daemon.status.loadingSubsystems = true
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      if (str.match(/... scanning height/)) {
        console.log('blockchain progress update')
        loadingSubsystems = true
        loki_daemon.status.loadingSubsystems = true
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      // 2020-09-28 01:47:50.074	I ... scanning height 121250 (4.9152s) (snl: 1.01874s; lns: 0s)
      // 2020-09-28 01:56:39.036	I Loading checkpoints
      if (str.match(/Loading checkpoints/)) {
        console.log('blockchain subsystem loaded')
        loadingSubsystems = false
        loki_daemon.status.loadingSubsystems = false
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }

      // syncingChain
      if (str.match(/SYNCHRONIZATION started/)) {
        console.log('blockchain sync started')
        syncingChain = true
        loki_daemon.status.syncingChain = true
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      if (str.match(/Synced/)) {
        // progress update
        syncingChain = true
        loki_daemon.status.syncingChain = true
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }
      if (str.match(/SYNCHRONIZED OK/)) {
        console.log('blockchain synchronized')
        syncingChain = false
        loki_daemon.status.syncingChain = false
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }


      // 2020-10-02 03:58:12.642	W Height: 243956 prev difficulty: 526886804205806, new difficulty: 526886804205807
      if (str.match(/prev difficulty/)) {
        console.warn('difficuly issue detected')
      }
      //
      // 2020-10-02 04:01:57.499	E Failed to load hashes - unexpected data size 40164, expected 80324
      if (str.match(/Failed to load hashes/)) {
        console.warn('Failed to load hashes, maybe re "download-blockchain"')
      }

      // 2020-10-12 03:11:00.660 I Failed to submit uptime proof: have not heard from the storage server recently. Make sure that it is running! It is required to run alongside the Loki daemon
      if (str.match(/have not heard from the/)) {
        console.warn('something maybe wrong...')
      }

      if (str.match(/Sync data returned a new top block candidate/)) {
        // these are normal, however too many in a row could mean a stall
        // especially combined with difficulty recalc
        console.warn('no blockchain communication with other nodes, something maybe wrong or it\'s about to start a sync...')
      }

      // we can get 3-4 before loki-storage pings a fresh restart
      if (str.match(/Failed to submit uptime proof: have not heard from the storage server recently/)) {
        var ts = Date.now()
        lastLokiStorageContactFailures.push(ts)
        // loki-storage may not be running
        // this should only happen on a double lokid restart
        // (wouldn't shouldn't ever happen now)
        // the 2nd lokid will die and kill everything
        // except the first lokid

        if (lastLokiStorageContactFailures.length > 20) {
          lastLokiStorageContactFailures.splice(-20)
        }
        if (!shuttingDown) {
          console.log('BLOCKCHAIN: Have not heard from oxen-storage, failure count', lastLokidContactFailures.length, 'first', parseInt((ts - lastLokiStorageContactFailures[0]) / 1000) + 's ago')
        }
        if (lastLokiStorageContactFailures.length == 20 && ts - lastLokiStorageContactFailures[0] < 900 * 1000) {
          // now it's a race, between us detect lokid shutting down
          // and us trying to restart it...
          // mainly will help deadlocks
          if (!exitRequested) { // user typed exit
            console.log('we should restart oxen-storage');
            //(config);
          }
        }
        console.log(`BLOCKCHAIN: storage tick contact failure`)
        loki_daemon.storageFailures.last_storage_tick = Date.now()
        //communicate this out
        lib.savePids(config, args, loki_daemon, lokinet, storageServer)
      }

      //var parts = data.toString().split(/\n/)
      //parts.pop()
      //stripped = parts.join('\n')
      //console.log(`blockchain: ${stripped}`)
      // seems to be working...
      if (server) {
        // broadcast
        for (var i in connections) {
          var conn = connections[i]
          conn.write(data + "\n")
        }
      }
      // FIXME: if we don't get `Received uptime-proof confirmation back from network for Service Node (yours): <24030a316d4b8379a4a7be640ee716632d40f76f2784074bcbffc4b0c617d6b7>`
      // at least once every 2 hours, restart lokid
    })
    loki_daemon.stdout.on('error', (err) => {
      console.error('BLOCKCHAIN1_ERR:', JSON.stringify(err))
    })
    loki_daemon.stderr.on('data', (data) => {
      console.log(`blockchainErrRAW: ${data}`)
      //var parts = data.toString().split(/\n/)
      //parts.pop()
      //stripped = parts.join('\n')
      //console.log(`blockchain: ${stripped}`)
      // seems to be working...
      if (server) {
        // broadcast
        for (var i in connections) {
          var conn = connections[i]
          conn.write("ERR" + data + "\n")
        }
      }
    })
    loki_daemon.stderr.on('error', (err) => {
      console.error('BLOCKCHAIN1_ERR:', JSON.stringify(err))
    })
  }

  loki_daemon.on('close', (code, signal) => {
    if (loki_daemon === null) {
      // was shutting down when it was restarted...
      loki_daemon = {
        shuttingDownRestart: true // set something we can modify behavior on
      }
    }
    console.warn(`BLOCKCHAIN: loki_daemon process exited with code ${code}/${signal} after`, (Date.now() - loki_daemon.startTime)+'ms')
    // invalid param gives a code 1
    // code 0 means clean shutdown
    if (code === 0) {
      // likely to mean it was requested
      if (config.blockchain.restart) {
        // we're just going to restart
        if (server) {
          // broadcast
          for (var i in connections) {
            var conn = connections[i]
            conn.write("Lokid has been exited but configured to restart. Disconnecting client and we'll be back shortly\n")
          }
        }
        // but lets disconnect any clients
        disconnectAllClients()
      }
    }
    // if we have a handle on who we were...
    if (loki_daemon) {
      loki_daemon.killed = true
      // clean up temporaries
      //killOutputFlushTimer()
      if (loki_daemon.outputFlushTimer) {
        clearTimeout(loki_daemon.outputFlushTimer)
        loki_daemon.outputFlushTimer = undefined
      }
      if (loki_daemon.getHeightTimer) {
        clearTimeout(loki_daemon.getHeightTimer)
        loki_daemon.getHeightTimer = undefined
      }
    }
    if (!shuttingDown) {
      // if we need to restart
      if (config.blockchain.restart) {
        console.log('BLOCKCHAIN: lokid is configured to be restarted. Will do so in 30s.')
        // restart it in 30 seconds to avoid pegging the cpu
        setTimeout(function () {
          console.log('BLOCKCHAIN: Restarting lokid.')
          launchLokid(config.blockchain.binary_path, lokid_options, config.launcher.interactive, config, args)
        }, 30 * 1000)
      } else {
        if (waitForLokiKeyTimer !== null) clearTimeout(waitForLokiKeyTimer)
        shutdown_everything()
      }
    }
  })


  function flushOutput() {
    if (shuttingDown) {
      loki_daemon.outputFlushTimer = false
      return
    }
    if (!loki_daemon) {
      console.log('BLOCKCHAIN: flushOutput lost handle, stopping flushing.')
      loki_daemon.outputFlushTimer = false
      return
    }
    // turn off when in prepare status...
    if (!inPrepareReg) {
      loki_daemon.stdin.write("\n")
    }
    // schedule next flush
    loki_daemon.outputFlushTimer = setTimeout(flushOutput, 1000)
  }
  // disable until we can detect prepare_reg
  // don't want to accidentally launch with prepare_reg broken
  loki_daemon.outputFlushTimer = setTimeout(flushOutput, 1000)

  loki_daemon.getHeightTimer = false
  loki_daemon.lastHeight = 0
  loki_daemon.heightStuckCounter = 0
  async function getHeight() {
    if (shuttingDown) {
      loki_daemon.getHeightTimer = false
      return
    }
    //console.log('daemon::getHeight - asking')
    const info = await lib.blockchainRpcGetNetInfo(config)
    //console.log('daemon::getHeight - info', info)
    //if (info.result.height < info.result.target_height) // syncing...
    // but it could be stuck syncing, right?
    if (!loki_daemon) {
      console.log('LAUNCHER: loki_daemon went away, stopping height check')
      return
    }
    if (info && info.result) {
      //console.log('daemon::getHeight - height', info.result.height)
      //console.log('daemon::getHeight - target_height', info.result.target_height)
      if (loki_daemon.lastHeight) {
        if (loki_daemon.lastHeight === info.result.height) {
          loki_daemon.heightStuckCounter++;
          // 3
          if (loki_daemon.heightStuckCounter > 3) {
            console.log('LAUNCHER: blockchain has detected a slow block or stall', info.result.height, 'for', loki_daemon.heightStuckCounter, 'tests now')
          }
          // 40 mins of being stuck
          // 10
          if (loki_daemon.heightStuckCounter > 10) {
            console.log('LAUNCHER: detected stuck blockchain, restarting')
            requestBlockchainRestart(config)
            return
          }
        } else {
          // reset if any movement
          loki_daemon.heightStuckCounter = 0
        }
      }
      loki_daemon.lastHeight = info.result.height
    }
    loki_daemon.getHeightTimer = setTimeout(getHeight, 2 * 2 * 60 * 1000)
  }

  // give it a minute to start up
  loki_daemon.getHeightTimer = setTimeout( () => {
    getHeight()
  }, 60 * 1000)

  if (cb) cb()
}

var requestBlockchainRestartLock = false
function requestBlockchainRestart(config, cb) {
  if (shuttingDown) {
    console.log('LAUNCHER: not going to restart lokid, we are shutting down')
    return
  }
  if (requestBlockchainRestartLock) {
    console.log('LAUNCHER: already restarting blockchain')
    return
  }
  requestBlockchainRestartLock = true
  var oldVal = config.blockchain.restart
  var obj = lib.getPids(config)
  config.blockchain.restart = 1
  console.log('LAUNCHER: requesting blockchain restart')
  shutdown_blockchain()
  waitfor_blockchain_shutdown(function() {
    // lokid will be done for 30s if it's being restarted.
    setTimeout(function() {
      if (shuttingDown) {
        console.log('LAUNCHER: not going to restart lokid, we are shutting down')
        return
      }
      console.log('BLOCKCHAIN: Releasing lokid restart lock. Restart setting being restored back to', oldVal)
      // we don't need to relauncher if we set restart = 1
      //launchLokid(config.blockchain.binary_path, obj.blockchain_startedOptions, config.launcher.interactive, config, obj.arg)
      requestBlockchainRestartLock = false
      config.blockchain.restart = oldVal
      if (cb) cb()
    }, (15 + 30) * 1000) // give it an extra 15s to start up
  })
}

function sendToClients(data) {
  if (server) {
    // broadcast
    for(var i in connections) {
      var conn = connections[i]
      conn.write(data + "\n")
    }
  }
}

function lokinet_onMessageSockerHandler(data) {
  if (lokinet.lokinetLogging) {
    console.log(`lokinet: ${data}`)
    sendToClients('NETWORK: ' + data + '\n')
  }
  const tline = data
  const lokinetProc = lokinet.isRunning()
  // blockchain ping
  if (tline.match(/invalid result from lokid ping, not an object/) || tline.match(/invalid result from lokid ping, no result/) ||
      tline.match(/invalid result from lokid ping, status not an string/) || tline.match(/lokid ping failed:/) ||
      tline.match(/Failed to ping lokid/)) {
    lokinetProc.blockchainFailures.last_blockchain_ping = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, loki_daemon, lokinet, storageServer)
  }
  // blockchain identity
  if (tline.match(/lokid gave no identity key/) || tline.match(/lokid gave invalid identity key/) ||
      tline.match(/lokid gave bogus identity key/) || tline.match(/Bad response from lokid:/) ||
      tline.match(/failed to get identity keys/) || tline.match(/failed to init curl/)) {
    lokinetProc.blockchainFailures.last_blockchain_identity = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, loki_daemon, lokinet, storageServer)
  }
  // blockchain get servide node
  if (tline.match(/Invalid result: not an object/) || tline.match(/Invalid result: no service_node_states member/) ||
      tline.match(/Invalid result: service_node_states is not an array/)) {
    lokinetProc.blockchainFailures.last_blockchain_snode = Date.now()
    // communicate this out
    lib.savePids(savePidConfig.config, savePidConfig.args, loki_daemon, lokinet, storageServer)
  }
}
function lokinet_onErrorSockerHandler(data) {
  console.log(`lokineterr: ${data}`)
  sendToClients('NETWORK ERR: ' + data + '\n')
}

function setUpLokinetHandlers() {
  lokinet.onMessage = lokinet_onMessageSockerHandler
  lokinet.onError   = lokinet_onErrorSockerHandler
}

function handleInput(line) {
  if (line.match(/^network/i)) {
    var remaining = line.replace(/^network\s*/i, '')
    if (remaining.match(/^log/i)) {
      var param = remaining.replace(/^log\s*/i, '')
      //console.log('lokinet log', param)
      if (param.match(/^off/i)) {
        lokinet.disableLogging()
      }
      if (param.match(/^on/i)) {
        lokinet.enableLogging()
      }
    }
    return true
  }
  if (line.match(/^storage/i)) {
    var remaining = line.replace(/^storage\s*/i, '')
    if (remaining.match(/^log/i)) {
      var param = remaining.replace(/^log\s*/i, '')
      //console.log('lokinet log', param)
      if (param.match(/^off/i)) {
        storageLogging = false
      }
      if (param.match(/^on/i)) {
        storageLogging = true
      }
    }
    return true
  }
  if (line.match(/^prepare_registration/)) {
    inPrepareReg = true
    // has to return false
  }
  // FIXME: it'd be nice to disable the periodic status report msgs in interactive too
  return false
}

// startLokid should generate a current config for launcherLokid
// but the launcherLokid config should be locked in and not changeable
// so startLokid is the last opportunity to update it
// and we'll recall this function if we need to update the config too...
// also implies we'd need a reload other than HUP, USR1?
function startLokid(config, args) {
  //console.log('startLokid', args)
  var parameters = configureLokid(config, args)
  //console.log('parameters', parameters)
  var lokid_options = parameters.lokid_options
  //console.log('configured ', config.blockchain.binary_path, lokid_options.join(' '))

  launchLokid(config.blockchain.binary_path, lokid_options, config.launcher.interactive, config, args)

  // if we're interactive (and no docker grab) the console
  if (config.launcher.interactive && lib.falsish(config.launcher.docker)) {
    // resume stdin in the parent process (node app won't quit all by itself
    // unless an error or process.exit() happens)
    stdin.resume()

    // i don't want binary, do you?
    stdin.setEncoding('utf8')

    // on any data into stdin
    stdin.on('data', function (key) {
      // ctrl-c ( end of text )
      if (key === '\u0003') {
        shutdown_everything()
        return
      }
      if (handleInput(key)) return
      if (!shuttingDown) {
        // local echo, write the key to stdout all normal like
        // on ssh we don't need this
        //process.stdout.write(key)

        // only if lokid is running, send input
        if (loki_daemon) {
          loki_daemon.stdin.write(key)
        }
      }
      if (key === 'exit\n') {
        //console.log('detected exit')
        // can't do this, this will prevent loki_daemon exit
        // from shuttingdown everything
        //shuttingDown = true
        exitRequested = true
        // force restart off
        config.blockchain.restart = false
      }
    })
    stdin.on('error', function(err) {
      console.error('STDIN ERR:', JSON.stringify(err))
    })
  } else {
    // we're non-interactive, set up socket server
    console.log('SOCKET: Starting')
    server = net.createServer((c) => {
      console.log('SOCKET: Client connected.')
      connections.push(c)
      c.setEncoding('utf8')
      c.on('end', () => {
        console.log('SOCKET: Client disconnected.')
        var idx = connections.indexOf(c)
        if (idx != -1) {
          connections.splice(idx, 1)
        }
      })
      c.on('error', (err) => {
        if (c.connected) {
          c.write('SOCKETERR: ' + JSON.stringify(err))
        } else {
          if (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_DESTROYED') {
            // make sure we remove ourself from broadcasts (lokid stdout writes)...
            var idx = connections.indexOf(c)
            if (idx != -1) {
              connections.splice(idx, 1)
            }
            // leave it to the client to reconnect
            // I don't think we need to log this
            // FIXME: don't CONNRESET when ctrl-c disconnecting the client...
          } else {
            console.log('Not connected, SOCKETERR:', JSON.stringify(err))
          }
        }
      })
      c.on('data', (data) => {
        var parts = data.toString().split(/\n/)
        parts.pop()
        stripped = parts.join('\n')
        console.log('SOCKET: got', stripped)
        if (handleInput(stripped)) return
        if (loki_daemon && !loki_daemon.killed) {
          console.log('SOCKET: Sending to lokid.')
          loki_daemon.stdin.write(data + "\n")
        }
      })
      c.write('Connection successful\n')
      // confirmed error is already catch above
      c.pipe(c)/* .on('error', function(err) {
        console.error('SOCKETSRV_ERR:', JSON.stringify(err))
      }) */
    })
    setUpLokinetHandlers()

    server.on('error', (err) => {
      if (err.code == 'EADDRINUSE') {
        // either already running or we were killed
        // try to connect to it
        net.connect({ path: config.launcher.var_path + '/launcher.socket' }, function () {
          // successfully connected, then it's in use...
          throw e;
        }).on('error', function (e) {
          if (e.code !== 'ECONNREFUSED') throw e
          console.log('SOCKET: socket is stale, nuking')
          fs.unlinkSync(config.launcher.var_path + '/launcher.socket')
          server.listen(config.launcher.var_path + '/launcher.socket')
        })
        return
      }
      console.error('SOCKET ERROR:', err)
      // some errors we need to shutdown
      //shutdown_everything()
    })

    server.listen(config.launcher.var_path + '/launcher.socket', () => {
      console.log('SOCKET: bound')
    })
  }

  if (config.web_api.enabled) {
    webApiServer = require(__dirname + '/web_api').start(config)
  }

  // only set up these handlers if we need to
  setupHandlers()
}

function getInterestingDaemonData() {
  var ts = Date.now()
  var lokinet_daemon = lokinet.getLokinetDaemonObj();
  var procInfo = {
    blockchain: {
      pid: loki_daemon?loki_daemon.pid:0,
      killed: loki_daemon?loki_daemon.killed:false,
      uptime: loki_daemon?(ts - loki_daemon.startTime):0,
      startTime: loki_daemon?loki_daemon.startTime:0,
      spawnfile: loki_daemon?loki_daemon.spawnfile:'',
      spawnargs: loki_daemon?loki_daemon.spawnargs:'',
    },
    network: {
      pid: lokinet?lokinet.pid:lokinet,
      killed: lokinet?lokinet.killed:false,
      uptime: lokinet?(ts - lokinet.startTime):0,
      startTime: lokinet?lokinet.startTime:0,
      spawnfile: lokinet?lokinet.spawnfile:'',
      spawnargs: lokinet?lokinet.spawnargs:'',
    },
    storage: {
      pid: storageServer?storageServer.pid:0,
      killed: storageServer?storageServer.killed:false,
      uptime: storageServer?(ts - storageServer.startTime):0,
      startTime: storageServer?storageServer.startTime:0,
      spawnfile: storageServer?storageServer.spawnfile:'',
      spawnargs: storageServer?storageServer.spawnargs:'',
    },
  }
  return procInfo;
}

var handlersSetup = false
function setupHandlers() {
  if (handlersSetup) return
  process.on('SIGHUP', () => {
    console.log('got SIGHUP!')
    if (savePidConfig.config) {
      console.log('updating pids file', savePidConfig.config.launcher.var_path + '/pids.json')
      lib.savePids(savePidConfig.config, savePidConfig.args, loki_daemon, lokinet, storageServer)
    }
    console.log('shuttingDown?', shuttingDown)
    const procInfo = getInterestingDaemonData()
    var nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
    if (nodeVer >= 10) {
      console.table(procInfo)
    } else {
      console.log(procInfo)
    }
    console.log('lokinet status', lokinet.isRunning())
  })
  // ctrl-c
  process.on('SIGINT', function () {
    console.log('LAUNCHER daemon got SIGINT (ctrl-c)')
    shutdown_everything()
  })
  // -15
  process.on('SIGTERM', function () {
    console.log('LAUNCHER daemon got SIGTERM (kill -15)')
    shutdown_everything()
  })
  handlersSetup = true
}

module.exports = {
  startLauncherDaemon: startLauncherDaemon,
  startLokinet: startLokinet,
  startStorageServer: startStorageServer,
  startLokid: startLokid,
  // for lib::runOfflineBlockchainRPC
  configureLokid: configureLokid,
  launchLokid: launchLokid,
  //
  waitForLokiKey: waitForLokiKey,
  setupHandlers: setupHandlers,
  shutdown_everything: shutdown_everything,
  config: {}
}
