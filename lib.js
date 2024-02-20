
// no npm!
const fs  = require('fs')
const cp  = require('child_process')
const net = require('net')
const http = require('http')
const https = require('https')
const urlparser = require('url')
const execSync = cp.execSync
const spawnSync = cp.spawnSync
const execFileSync = cp.execFileSync

const VERSION = 0.1

//
// common functions for client and daemon
//

function hereDoc(f) {
  return f.toString().
    replace(/^[^\/]+\/\*!?/, '').
    replace(/\*\/[^\/]+$/, '')
}

const logo = hereDoc(function () {/*!
__LABEL__

                                       /;    ;\
                                   __  \\____//
                                  /{_\_/   `'\____
                                  \___   (o)  (o  }
       _____________________________/          :--'
   ,-,'`@@@@@@@@       @@@@@@         \_    `__\
  ;:(  @@@@@@@@@        @@@             \___(o'o)
  :: )  @@@@          @@@@@@        ,'@@(  `===='
  :: : @@@@@:          @@@@         `@@@:
  :: \  @@@@@:       @@@@@@@)    (  '@@@'
  ;; /\      /`,    @@@@@@@@@\   :@@@@@)
  ::/  )    {_----------------:  :~`,~~;
 ;;'`; :   )                  :  / `; ;
;;;; : :   ;                  :  ;  ; :
`'`' / :  :                   :  :  : :
    )_ \__;      ";"          :_ ;  \_\       `,','
    :__\  \    * `,'*         \  \  :  \   *  8`;'*  *
        `^'     \ :/           `^'  `-^-'   \v/ :  \/
Art by Bill Ames
*/});

function getLogo(str) {
  //'L A U N C H E R   v e r s i o n   v version'
  //return logo.replace(/__LABEL__/, str)
  return str;
}

function falsish(val) {
  if (val === undefined) return true
  if (val === null) return true
  if (val === false) return true
  if (val === 0) return true
  if (val === true) return false
  if (val === 1) return false
  if (val.toLowerCase() === 'false') return true
  if (val.toLowerCase() === 'no') return true
  if (val.toLowerCase() === 'off') return true
  return false
}

let blockchainVersion = null
function getBlockchainVersion(config) {
  if (blockchainVersion !== null) return blockchainVersion
  if (config.blockchain.binary_path && fs.existsSync(config.blockchain.binary_path)) {
    try {
      const stdout = execFileSync(config.blockchain.binary_path, ['--version'])
      blockchainVersion = stdout.toString().trim()
      //console.log('lokid_version', lokid_version)
      // Loki 'Nimble Nerthus' (v6.1.4-6f78319d0)
      return blockchainVersion
    } catch(e) {
      /*
Cant detect blockchain version Error: Command failed: /opt/loki-launcher/bin/lokid --version
/opt/loki-launcher/bin/lokid: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.25' not found (required by /opt/loki-launcher/bin/lokid)

    at checkExecSyncError (child_process.js:621:11)
    at execFileSync (child_process.js:639:15)
    at Object.getBlockchainVersion (/root/loki-daemon-launcher/lib.js:66:22)
    at getLokidVersion (/root/loki-daemon-launcher/config.js:291:31)
    at isBlockchainBinary3X (/root/loki-daemon-launcher/config.js:312:3)
    at checkLauncherConfig (/root/loki-daemon-launcher/config.js:347:9)
    at Object.checkConfig [as check] (/root/loki-daemon-launcher/config.js:821:3)
    at continueStart (/root/loki-daemon-launcher/index.js:125:14)
    at Object.<anonymous> (/root/loki-daemon-launcher/index.js:22:3)
    at Module._compile (internal/modules/cjs/loader.js:936:30) {
  status: 1,
  signal: null,
  output: [
    null,
    <Buffer >,
    <Buffer 2f 6f 70 74 2f 6c 6f 6b 69 2d 6c 61 75 6e 63 68 65 72 2f 62 69 6e 2f 6c 6f 6b 69 64 3a 20 2f 6c 69 62 2f 78 38 36 5f 36 34 2d 6c 69 6e 75 78 2d 67 6e ... 87 more bytes>
  ],
  pid: 442253,
  stdout: <Buffer >,
  stderr: <Buffer 2f 6f 70 74 2f 6c 6f 6b 69 2d 6c 61 75 6e 63 68 65 72 2f 62 69 6e 2f 6c 6f 6b 69 64 3a 20 2f 6c 69 62 2f 78 38 36 5f 36 34 2d 6c 69 6e 75 78 2d 67 6e ... 87 more bytes>
      */
      // stderr seems to be already echo'd
      if (e.code === 'EACCES') {
        console.error("Cannot detect blockchain version. Your current oxend binary does not have the correct permissions, please run: 'sudo oxen-rancher fix-perms USER' where USER is the username you run rancher as, usually snode")
      } else
      if (e.signal === 'SIGILL') {
        console.error("Cannot detect blockchain version. Your current oxend binary does not support your CPU")
      } else {
        // not a crash but bad exit..
        if (e.signal === null && e.status === 1 && e.error === null) {
          // LIBC error
          console.log('message', e.message)
        }
        console.error("Cannot detect blockchain version", e)
        //console.error('Cant detect blockchain version', e.stdout.toString())
      }
      // can't hurt to retry I guess, maybe it is a temp problem
    }
  }
  return false;
}

let storageVersion = null
function getStorageVersion(config) {
  if (storageVersion !== null) return storageVersion
  if (config.storage.binary_path && fs.existsSync(config.storage.binary_path)) {
    try {
      // data-dir has to exist to get the version
      //const tempdir = lokinet.randomString(8)
      let tempDir = '/tmp/loki-storage-vercheck-' + config.storage.port
      let tempPath = tempDir + '/storage.logs'
      //console.log('existsSync?', tempPath)
      if (fs.existsSync(tempPath)) {
        //console.log('existsSync')
        try {
          fs.accessSync(tempPath, fs.constants.R_OK | fs.constants.W_OK);
          //console.log('can read/write');
        } catch (err) {
          //console.error('no access!');
          const lokinet = require(__dirname + '/lokinet')
          tempDir = '/tmp/loki-storage-vercheck-' + lokinet.randomString(8)
          tempPath = tempDir + '/storage.logs'
        }
      }
      const stdout = execFileSync(config.storage.binary_path, ['--data-dir', tempDir, '-v'])
      try {
        fs.unlinkSync(tempPath)
        fs.rmdirSync(tempDir)
      } catch (e) {
        // no big deal, still return version
      }
      const storage_version = stdout.toString().trim()
      //console.log('storage_version', storage_version)
      const lines = storage_version.split(/\n/)
      //console.log('storage_version', lines.length, lines)
      const foundVer = lines.filter(line => line.match(/Oxen Storage Server v/))
      if (!foundVer.length) {
        console.error('LIB: could not find version line', lines)
        return storage_version
      }
      if (foundVer.length > 1) {
        console.warn('LIB: found multiple versions', foundVer, 'using first')
      }
      if (!foundVer[0].replace) {
        console.error('LIB: version line is not string?!?')
        return storage_version
      }
      storageVersion = foundVer[0].replace(' [info] [print_version]', '')
      return storageVersion
      /*
      // 2.0.7 uses 3 instead of 6...
      let useLine = lines.length === 3 ? 0 : 3;
      // [2020-03-12 07:53:16.940] [info] [print_version] Loki Storage Server v1.0.10
      if (lines[useLine].match(/Loki Storage Server v/)) {
        storageVersion = lines[useLine].replace(' [info] [print_version]', '')
        return storageVersion
      }
      return storage_version
      */
    } catch(e) {
      if (e.code === 'EACCES') {
        console.error("Cannot detect storage version. Your current oxen-storage binary does not have the correct permissions, please run: 'sudo oxen-rancher fix-perms USER' where USER is the username you run rancher as, usually snode")
      } else
      if (e.signal === 'SIGILL') {
        console.error("Cannot detect storage version. Your current oxen-storage binary does not support your CPU")
      } else {
        console.error("Cannot detect storage version", e)
      }
      // can't hurt to retry I guess, maybe it is a temp problem
    }
  }
  return false;
}

let networkVersion = null
function getNetworkVersion(config) {
  if (networkVersion !== null) return networkVersion
  if (config.network.binary_path && fs.existsSync(config.network.binary_path)) {
    try {
      const stdout = execFileSync(config.network.binary_path, ['--version'])
      networkVersion = stdout.toString().trim()
      //console.log('network_version', network_version)
      // lokinet-0.7.0-50514d55b
      return networkVersion
    } catch(e) {
      if (e.code === 'EACCES') {
        console.error("Cannot detect network version. Your current lokinet binary does not have the correct permissions, please run: 'sudo oxen-rancher fix-perms USER' where USER is the username you run rancher as, usually snode")
      } else
      if (e.signal === 'SIGILL') {
        console.error("Cannot detect network version. Your current lokinet binary does not support your CPU")
/*
Cant detect network version { Error: Command failed: /opt/loki-launcher/bin/lokinet --version
    at checkExecSyncError (child_process.js:629:11)
    at execFileSync (child_process.js:647:13)
    at Object.getNetworkVersion (/root/snodes/sn7/lib.js:159:22)
    at showVersions (/root/snodes/sn7/index.js:198:53)
    at continueStart (/root/snodes/sn7/index.js:684:7)
    at Object.<anonymous> (/root/snodes/sn7/index.js:22:3)
    at Module._compile (internal/modules/cjs/loader.js:778:30)
    at Object.Module._extensions..js (internal/modules/cjs/loader.js:789:10)
    at Module.load (internal/modules/cjs/loader.js:653:32)
    at tryModuleLoad (internal/modules/cjs/loader.js:593:12)
  status: null,
  signal: 'SIGILL',
  output: [ null, <Buffer >, <Buffer > ],
  pid: 52131,
  stdout: <Buffer >,
  stderr: <Buffer > }
*/
      } else {
        console.error('Cant detect network version', e)
      }
      // can't hurt to retry I guess, maybe it is a temp problem
    }
  }
  return false;
}

function pidUser(pid) {
  const ps = spawnSync('ps', ['-fp', pid])
  if (ps.status != '0') {
    // can't find pid
    //console.warn('ps and kill -0 disagree. ps.status:', ps.status, 'expected 0', ps.stdout.toString(), ps.stderr.toString())
    // usually a race, and has already quit...
    return 'unknown'
  }
  const lines = ps.output.toString().split(/\n/)
  if (lines.length != 3) {
    console.log('pidUser ps lines', lines.length, 'not 2')
    return 'unknown'
  }
  lines.shift() // bye bye first line
  const lastLines = lines[0].split(/\W+/)
  const user = lastLines[0]
  return user
}

function isPidRunning(pid) {
  if (pid === undefined) {
    console.trace('isPidRunning was passed undefined, reporting not running')
    return false
  }
  try {
    // trim any trailing whitespace (using echo > to create does this)
    if (pid.trim) pid = pid.trim()
    //console.log(`checking [${pid}]`)
    process.kill(pid, 0)
    // node 10.16.0 ignores kill 0 (maybe only in lxc but it does)
    // so we're try a SIGHUP
    // can't use SIGHUP lokid dies..
    //process.kill(pid, 'SIGHUP')
    const ps = spawnSync('ps', ['-p', pid])
    //console.log('output', ps.output.toString())
    //console.log('status', ps.status)
    if (ps.status != '0') {
      // can't find pid
      //console.warn('ps and kill -0 disagree. ps.status:', ps.status, 'expected 0', ps.stdout.toString(), ps.stderr.toString())
      // usually a race, and has already quit...
      return false
    }
    //console.log('able to kill', pid)
    return true
  } catch (e) {
    //console.log(pid, 'isRunning', e.code)
    if (e.code === undefined) {
      console.error('ps err', e)
    }
    if (e.code == 'ERR_INVALID_ARG_TYPE') {
      // means pid was undefined
      return false
    }
    if (e.code == 'ESRCH') {
      // not running
      return false
    }
    if (e.code == 'EPERM') {
      // we're don't have enough permissions to signal this process
      return true
    }
    console.log(pid, 'isRunning', e.code, e.message)
    return false
  }
  return false
}

function clearStartupLock(config) {
  // clear our start up lock (if needed, will crash if not there)
  if (fs.existsSync(config.launcher.var_path + '/launcher.pid')) {
    fs.unlinkSync(config.launcher.var_path + '/launcher.pid')
  }
}

const TO_MB = 1024 * 1024

function areWeRunning(config) {
  let pid = 0 // default is not running
  if (fs.existsSync(config.launcher.var_path + '/launcher.pid')) {
    // we are already running
    // can be deleted between these two points...
    try {
      pid = fs.readFileSync(config.launcher.var_path + '/launcher.pid', 'utf8')
      // trim any trailing whitespace (using echo > to create does this)
      if (pid.trim) pid = pid.trim()
    } catch(e) {
      return 0
    }
    //console.log('pid is', pid)
    if (pid && isPidRunning(pid)) {
      // pid is correct, syslog could take this spot, verify the name
      //console.log('our process name', process.title)
      let stdout = ''
      try {
        stdout = execSync('ps -p ' + pid + ' -ww -o pid,ppid,uid,gid,args', {
          maxBuffer: 2 * TO_MB,
          windowsHide: true
        })
      } catch(e) {
        console.log('Can not check process name')
        return 0
      }
      //console.log('stdout', typeof(stdout), stdout)
      const lines = stdout.toString().split(/\n/)
      const labels = lines.shift().trim().split(/( |\t)+/)
      //console.log(0, labels)
      // 0PID, 2PPID, 4UID, 6GID, 8ARGS
      let verifiedPid = false
      let foundPid = false
      for(var i in lines) {
        const tLine = lines[i].trim().split(/( |\t)+/)
        //console.log(i, tLine)
        const firsts = tLine.splice(0, 8)
        const thisPid = firsts[0]
        const cmd = tLine.join(' ')
        if (thisPid == pid) {
          foundPid = true
          // /usr/local/bin/node   /Users/admin/Sites/loki-daemon-launcher/index.js ...
          //console.log(thisPid, 'cmd', cmd)
          if (cmd.match(/node/) || cmd.match(/index\.js/) || cmd.match(/loki-launcher/)) {
            verifiedPid = true
          }
        }
      }
      // detect incorrectly parsed ps
      if (!foundPid) {
        console.warn('Could not read your process-list to determine if pid', pid, 'is really rancher or not', stdout)
      } else
      if (!verifiedPid) {
        // what's worse?
        // 1. running a 2nd copy of launcher
        // 2. or not starting at all...
        // how would one clean up this mess?
        // check the socket...
        // well clear the pid file
        // is it just the launcher running?
        console.warn('Could not verify that pid', pid, 'is actually the rancher by process title')
        const pids = getPids(config)
        const blockchainIsRunning = pids.lokid && isPidRunning(pids.lokid)
        const networkIsRunning = config.network.enabled && pids.lokinet && isPidRunning(pids.lokinet)
        const storageIsRunning = config.storage.enabled && pids.storageServer && isPidRunning(pids.storageServer)
        if (!blockchainIsRunning && !networkIsRunning && !storageIsRunning) {
          console.log('Subprocess are not found, will request fresh start')
          //clearStartupLock(config)
          pid = 0
        }
      }
    } else {
      // so many calls
      // do we need to say this everytime?
      // will be stale if launcher.cimode is true
      console.log('stale ' + config.launcher.var_path + '/launcher.pid (' + pid + '), removing...')
      // should we nuke this proven incorrect file? yes
      fs.unlinkSync(config.launcher.var_path + '/launcher.pid')
      // FIXME: maybe have a lastrun file for debugging
      pid = 0
    }
  }
  return pid
}

function setStartupLock(config) {
  //console.log('SETTING STARTUP LOCK')
  fs.writeFileSync(config.launcher.var_path + '/launcher.pid', '' + process.pid)
}

function clearPids(config) {
  //console.log('CLEARING STARTUP LOCK')
  if (fs.existsSync(config.launcher.var_path + '/pids.json')) {
    console.log('LAUNCHER: clearing ' + config.launcher.var_path + '/pids.json')
    fs.unlinkSync(config.launcher.var_path + '/pids.json')
  } else {
    console.log('LAUNCHER: NO ' + config.launcher.var_path + '/pids.json found, can\'t clear')
  }
}

function savePids(config, args, loki_daemon, lokinet, storageServer) {
  var obj = {
    runningConfig: config,
    arg: args,
    launcher: process.pid
  }
  if (loki_daemon && !loki_daemon.killed && loki_daemon.pid) {
    obj.lokid = loki_daemon.pid
    obj.blockchain_startTime      = loki_daemon.startTime
    obj.blockchain_startedOptions = loki_daemon.startedOptions
    obj.blockchain_spawn_file     = loki_daemon.spawnfile
    obj.blockchain_spawn_args     = loki_daemon.spawnargs
    obj.blockchain_status         = loki_daemon.status
  }
  if (storageServer && !storageServer.killed && storageServer.pid) {
    obj.storageServer      = storageServer.pid
    obj.storage_startTime  = storageServer.startTime
    obj.storage_spawn_file = storageServer.spawnfile
    obj.storage_spawn_args = storageServer.spawnargs
    obj.storage_blockchain_failures = storageServer.blockchainFailures
  }
  var lokinetPID = lokinet.getPID()
  if (lokinetPID) {
    var lokinet_daemon = lokinet.getLokinetDaemonObj()
    obj.lokinet            = lokinetPID
    obj.network_startTime  = lokinet_daemon.startTime
    obj.network_spawn_file = lokinet_daemon.spawnfile
    obj.network_spawn_args = lokinet_daemon.spawnargs
    obj.network_blockchain_failures = lokinet_daemon.blockchainFailures
  }
  const path = config.launcher.var_path + '/pids.json'
  if (fs.existsSync(config.launcher.var_path + '/pids.json')) {
    fs.access(path, fs.W_OK, function(err) {
      if (err) {
        console.error('lib::savePIds - err', err)
      } else {
        // node 14.x, would stop processing here if own by root and running as snode
        fs.writeFileSync(path, JSON.stringify(obj))
      }
    })
  } else {
    // just make it...
    fs.writeFileSync(path, JSON.stringify(obj))
  }
}

function getPids(config) {
  if (!fs.existsSync(config.launcher.var_path + '/pids.json')) {
    return { err: "noFile" }
  }
  // we are already running
  var json
  try {
    json = fs.readFileSync(config.launcher.var_path + '/pids.json', 'utf8')
  } catch (e) {
    // we had one integration test say this file was deleted after the existence check
    console.warn(config.launcher.var_path + '/pids.json', 'had a problem', e)
    return { err: "noRead" }
  }
  var obj = { err: "noParse" }
  try {
    obj = JSON.parse(json)
  } catch (e) {
    console.error('Can not parse JSON from', config.launcher.var_path + '/pids.json', json)
  }
  return obj
}

// is this the stupidest function or what?
function getProcessState(config) {
  // what happens if we get different options than what we had before
  // maybe prompt to confirm restart
  // if already running just connect for now
  var running = {}
  var pid = areWeRunning(config)
  if (pid) {
    running.launcher = pid
  }
  var pids = getPids(config)
  //console.log('getProcessState pids', pids)
  if (pids.lokid && isPidRunning(pids.lokid)) {
    //console.log("LAUNCHER: old lokid is still running", pids.lokid)
    running.lokid = pids.lokid
  }
  // console.log('network', config.network.enabled, 'lokinet', pids.lokinet)
  if (config.network.enabled) {
    if (pids.lokinet && isPidRunning(pids.lokinet)) {
      //console.log("LAUNCHER: old lokinet is still running", pids.lokinet)
      running.lokinet = pids.lokinet
    }
  }
  if (config.storage.enabled) {
    if (pids.storageServer && isPidRunning(pids.storageServer)) {
      //console.log("LAUNCHER: old storage server is still running", pids.storageServer)
      running.storageServer = pids.storageServer
    }
  }
  return running
}

var rpcIdCounter = 0

function runBlockchainRPCTest(config, cb) {
  var useIp = config.blockchain.rpc_ip
  if (useIp === '0.0.0.0') useIp = '127.0.0.1'
  const url = 'http://' + useIp + ':' + config.blockchain.rpc_port + '/json_rpc'
  rpcIdCounter++
  const jsonPost = {
    jsonrpc: "2.0",
    id: rpcIdCounter,
    method: "get_info"
  }
  try {
    httpPost(url, JSON.stringify(jsonPost), { quiet: true }, function(json) {
      cb(json)
    })
  } catch (e) {
    cb()
  }
}

async function blockchainRpcGetNetInfo(config, cb) {
  var useIp = config.blockchain.rpc_ip
  if (useIp === '0.0.0.0') useIp = '127.0.0.1'
  const url = 'http://' + useIp + ':' + config.blockchain.rpc_port + '/json_rpc'
  rpcIdCounter++
  const jsonPost = {
    jsonrpc: "2.0",
    id: rpcIdCounter,
    method: "get_info",
    params: {}
  }
  try {
    const json = await httpPost(url, JSON.stringify(jsonPost), cb)
    return JSON.parse(json)
  } catch (e) {
    return false
  }
}

async function blockchainRpcGetKey(config, cb) {
  var useIp = config.blockchain.rpc_ip
  if (useIp === '0.0.0.0') useIp = '127.0.0.1'
  const url = 'http://' + useIp + ':' + config.blockchain.rpc_port + '/json_rpc'
  rpcIdCounter++
  const jsonPost = {
    jsonrpc: "2.0",
    id: rpcIdCounter,
    method: "get_service_node_key",
    params: {}
  }
  try {
    const json = await httpPost(url, JSON.stringify(jsonPost), cb)
    return JSON.parse(json)
  } catch (e) {
    return false
  }
}

async function blockchainRpcGetObligationsQuorum(config, options, cb) {
  var useIp = config.blockchain.rpc_ip
  if (useIp === '0.0.0.0') useIp = '127.0.0.1'
  const url = 'http://' + useIp + ':' + config.blockchain.rpc_port + '/json_rpc'
  rpcIdCounter++
  const jsonPost = {
    jsonrpc: "2.0",
    id: rpcIdCounter,
    method: "get_quorum_state",
    params: { quorum_type: 0 }
  }
  if (options.start_height) {
    jsonPost.params.start_height = parseInt(options.start_height)
  }
  if (options.end_height) {
    jsonPost.params.end_height = parseInt(options.end_height)
  }
  // console.log('jsonPost', jsonPost)
  try {
    const json = await httpPost(url, JSON.stringify(jsonPost), cb)
    return JSON.parse(json)
  } catch (e) {
    return false
  }
}

async function runStorageRPCTest(lokinet, config, cb) {
  var url = 'https://' + config.storage.ip + ':' + config.storage.port + '/get_stats/v1'
  //console.log('Storage server is running, checking to make sure it\'s responding')
  //console.log('storage', config.storage)
  //console.log('asking', url)
  var responded = false
  var ref = {
    abort: function () {
      // usually get this why oxend is syncing...
      // sometimes httpGet wasn't called
      console.log('runStorageRPCTest abort or timeout, is oxend syncing?')
    }
  }
  var storage_rpc_timer = setTimeout(function() {
    if (responded) return
    responded = true
    ref.abort()
    cb()
  }, 5000)
  var oldTLSValue = process.env["NODE_TLS_REJECT_UNAUTHORIZED"]
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = '0' // turn it off for now
  let data
  try {
    data =  await lokinet.httpGet(url)
  } catch(e) {
    if (e !== undefined) {
      if (e.code === 'ECONNREFUSED') {
        // simply not listening/running (yet...?)
      } else {
        // most e are already displayed in httpGet
        //console.error('runStorageRPCTest httpGet failure', e)
      }
    } else {
      // a reject...
      // shutdown or 404/403
    }
  }
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = oldTLSValue
  clearTimeout(storage_rpc_timer)
  if (responded) return
  responded = true
  if (cb) cb(data)
  return data
}

async function runNetworkRPCTest(config, cb) {
  var useIp = config.network.rpc_ip
  if (useIp === '0.0.0.0') useIp = '127.0.0.1'
  const url = 'http://' + useIp + ':' + config.network.rpc_port + '/'
  const jsonPost = {
    jsonrpc: "2.0",
    id: "0",
    method: "llarp.version"
  }
  try {
    const json = await httpPost(url, JSON.stringify(jsonPost))
    console.log('json', json)
    // 0.6.x support
    if (json === 'bad json object') {
      if (cb) cb(true)
      return true
    } else {
      if (cb) cb(false)
      return false
    }
  } catch(e) {
    console.error('runNetworkRPCTest error', e)
  }
  //var data = JSON.parse(json)
  //console.log('result', data.result)
  // get_block_count
  // console.log('block count', data.result.count)
}

// won't take longer than 5s
// offlineMessage is waiting... or offline
async function getLauncherStatus(config, lokinet, offlineMessage, cb) {
  //console.debug('getLauncherStatus start')
  var checklist = {}
  var running = getProcessState(config)
  //console.debug('getLauncherStatus running', running)
  // pid...
  checklist.launcher = running.launcher ? ('running as ' + running.launcher) : offlineMessage
  checklist.blockchain = running.lokid ? ('running as ' + running.lokid) : offlineMessage

  var pids = getPids(config) // need to get the active config
  // if not running, just use our current config
  if (!pids.runningConfig) {
    pids.runningConfig = config
  }
  var need = {
  }

  // make sure need is configured here
  // console.log('config', pids.runningConfig)
  // console.log('running', running)
  if (pids.runningConfig.storage.enabled && running.storageServer) {
    need.storage_rpc = false
  }
  let socketExists = fs.existsSync(pids.runningConfig.launcher.var_path + '/launcher.socket')
  if (socketExists) {
    need.socketWorks = false
  }
  if (running.lokid) {
    need.blockchain_rpc = false
  }
  // need is now set up
  // console.log('needs', need)

  let doneResolver
  const donePromise = new Promise(res => {
    doneResolver = res
  })
  //console.debug('initial needs', need)

  function checkDone(task) {
    //console.debug('checking done', task, need)
    need[task] = true
    for(var i in need) {
      // if still need something
      if (need[i] === false) {
        //console.debug('getLauncherStatus checkDone still needs', need[i])
        return
      }
    }
    //console.debug('DONE!', need)
    // all tasks complete
    cb(running, checklist)
    doneResolver()
  }

  // this flat out doesn't matter any more in a post ss 2.x world
  /*
  if (pids.runningConfig.network.enabled || pids.runningConfig.storage.enabled) {
    if (running.lokid) {
      //console.log('lokid_key', config.storage.lokid_key)
      if (!configUtil.isStorageBinary2X(config)) {
        checklist.lokiKey = fs.existsSync(pids.runningConfig.blockchain.lokid_key) ? ('found at ' + pids.runningConfig.blockchain.lokid_key) : offlineMessage
      }
      checklist.lokiEdKey = fs.existsSync(pids.runningConfig.blockchain.lokid_edkey) ? ('found at ' + pids.runningConfig.blockchain.lokid_edkey) : offlineMessage
    }
  }
  */

  if (pids.runningConfig.network.enabled) {
    checklist.network = running.lokinet ? ('running as ' + running.lokinet) : offlineMessage
    // lokinet rpc check?
  }
  if (pids.runningConfig.storage.enabled) {
    checklist.storageServer = running.storageServer ? ('running as ' + running.storageServer) : offlineMessage
  }

  // socket...
  if (running.lokid) {
    checklist.blockchain_rpc = 'Checking...'
    var url = 'http://' + pids.runningConfig.blockchain.rpc_ip + ':' + pids.runningConfig.blockchain.rpc_port + '/json_rpc'
    //console.log('Lokid is running, checking to make sure it\'s responding')
    //console.log('blockchain', config.blockchain)
    var responded = false
    var p
    var blockchain_rpc_timer = setTimeout(function() {
      if (responded) return
      responded = true
      if (p && p.ref.abort) {
        p.ref.abort()
      } else {
        console.warn('can not aborted http request, handle type:', typeof(p), typeof(p.ref), typeof(p.ref.abort))
      }
      checklist.blockchain_rpc = offlineMessage
      checkDone('blockchain_rpc')
    }, 5000)

    if (pids.blockchain_status) {
      var status = []
      if (pids.blockchain_status.loadingSubsystems) {
        status.push('loadingSubsystems')
      }
      if (pids.blockchain_status.syncingChain) {
        status.push('syncingChain')
      }
      if (status.length) {
        checklist.blockchain_status = status.join(' ')
      }
    }

    // returns a promise now..
    try {
      var p = httpPost(url, '{}', function(data) {
        if (responded) return
        responded = true
        clearTimeout(blockchain_rpc_timer)
        if (data === undefined) {
          checklist.blockchain_rpc = offlineMessage
        } else {
          checklist.blockchain_rpc = 'running on ' + pids.runningConfig.blockchain.rpc_ip + ':' + pids.runningConfig.blockchain.rpc_port
        }
        checkDone('blockchain_rpc')
      })
    } catch(e) {
      console.error('getLauncherStatus err', e)
    }
  }
  /*
  if (pids.runningConfig && pids.runningConfig.blockchain) {
    need.blockchain_rpc = false
    lokinet.portIsFree(pids.runningConfig.blockchain.rpc_ip, pids.runningConfig.blockchain.rpc_port, function(portFree) {
      //console.log('rpc:', pids.runningConfig.blockchain.rpc_ip + ':' + pids.runningConfig.blockchain.rpc_port, 'status', portFree?'not running':'running')
      //console.log('')
      checklist.blockchain_rpc = portFree ? offlineMessage :('running on ' + pids.runningConfig.blockchain.rpc_ip + ':' + pids.runningConfig.blockchain.rpc_port)
      checkDone('blockchain_rpc')
    })
  }
  */

  if (pids.runningConfig.storage.enabled && running.storageServer) {
    if (pids.storage_blockchain_failures && pids.storage_blockchain_failures.last_blockchain_test) {
      checklist.storage_last_failure_blockchain_test = new Date(pids.storage_blockchain_failures.last_blockchain_test)+''
    }
    if (pids.storage_blockchain_failures && pids.storage_blockchain_failures.last_blockchain_ping) {
      checklist.storage_last_failure_blockchain_ping = new Date(pids.storage_blockchain_failures.last_blockchain_ping)+''
    }
    if (pids.storage_blockchain_failures && pids.storage_blockchain_failures.last_blockchain_tick) {
      checklist.storage_last_failure_blockchain_tick = new Date(pids.storage_blockchain_failures.last_blockchain_tick)+''
    }
    checklist.storage_rpc = 'Checking...'
    function runStorageTest() {
      runStorageRPCTest(lokinet, pids.runningConfig, function(data) {
        if (data === undefined) {
          checklist.storage_rpc = offlineMessage
        } else {
          //console.log('data', data)
          checklist.storage_rpc = 'running on ' + pids.runningConfig.storage.ip + ':' + pids.runningConfig.storage.port
        }
        checkDone('storage_rpc')
      })
    }
    if (pids.runningConfig.storage.ip === undefined) {
      // well can't use 0.0.0.0
      // don't lokinet running to use the lokinet interface
      // just need a list of interfaces...
      if (pids.runningConfig.launcher.publicIPv4) {
        pids.runningConfig.storage.ip = pids.runningConfig.launcher.publicIPv4
        return runStorageTest()
      }
      lokinet.checkConfig() // set up test config for getNetworkIP
      lokinet.getNetworkIP(function(err, localIP) {
        if (err) console.error('lib::getLauncherStatus - lokinet.getNetworkIP', err)
        pids.runningConfig.storage.ip = localIP
        runStorageTest()
      })
    } else {
      runStorageTest()
    }
  }

  if (socketExists) {
    let socketClientTest = net.connect({ path: pids.runningConfig.launcher.var_path + '/launcher.socket' }, function () {
      // successfully connected, then it's in use...
      checklist.socketWorks = 'running at ' + pids.runningConfig.launcher.var_path
      socketClientTest.end()
      socketClientTest.destroy()
      checkDone('socketWorks')
    }).on('error', function (e) {
      if (e.code === 'ECONNREFUSED') {
        console.log('SOCKET: socket is stale, nuking')
        fs.unlinkSync(pids.runningConfig.launcher.var_path + '/launcher.socket')
      }
      checklist.socketWorks = offlineMessage
      checkDone('socketWorks')
    })
  }
  // don't want to say everything is stopped but this is running if it's stale
  //checklist.push('socket', pids.lokid?'running':offlineMessage)


  if (pids.runningConfig.network.enabled) {
    if (pids.network_blockchain_failures && pids.network_blockchain_failures.last_blockchain_ping) {
      checklist.network_last_failure_blockchain_ping = new Date(pids.network_blockchain_failures.last_blockchain_ping)+''
    }
    if (pids.network_blockchain_failures && pids.network_blockchain_failures.last_blockchain_identity) {
      checklist.network_last_failure_blockchain_test = new Date(pids.network_blockchain_failures.last_blockchain_identity)+''
    }
    if (pids.network_blockchain_failures && pids.network_blockchain_failures.last_blockchain_snode) {
      checklist.network_last_failure_blockchain_snode = new Date(pids.network_blockchain_failures.last_blockchain_snode)+''
    }

    // if lokinet rpc is enabled...
    //need.network_rpc = true
    // checkDone('network_rpc')
  }

  if (Object.values(need).length === 0) {
    console.log('launcher still launching processes...')
    doneResolver()
    // the await seems to hang it still..
    cb(running, checklist)
    return
  }

  //console.debug('awaiting...', need)
  await donePromise
  //console.debug('awaited!')
}

// only stop lokid, which should stop any launcher
function stopLokid(config) {
  var running = getProcessState(config)
  if (running.lokid) {
    var pids = getPids(config)
    console.log('blockchain is running, requesting shutdown')
    // can't use 15
    process.kill(pids.lokid, 'SIGTERM')
    return 1
  }
  return 0
}

// called by index and modes/
function stopLauncher(config) {
  const systemdUtils = require(__dirname + '/modes/check-systemd')
  if (systemdUtils.isSystemdEnabled(config)) {
    //console.log('systemd lokid service is enabled')
    if (systemdUtils.isStartedWithSystemD()) {
      //console.log('systemd lokid service is active, stopping with systemd')
      // are we root?
      if (process.getuid() !== 0) {
        //console.log("this command isn't running as root, so can't stop launcher, run again with sudo")
      } else {
        try {
          const stdoutBuf = execSync('systemctl stop lokid')
          console.log("launcher has been stopped")
          return
        } catch(e) {
          console.log("stopping via systemd failed, falling back")
        }
      }
    }
  }

  // locate launcher pid
  var pid = areWeRunning(config)

  // FIXME: add try/catch in case of EPERM
  // request launcher shutdown...
  var count = 0
  if (pid) {
    // request launcher stop
    if (systemdUtils.isStartedWithSystemD()) {
      console.warn('launcher was set up with systemd, and you will need to run with sudo like')
      //console.warn('"sudo systemctl stop lokid.service" before running this')
      console.warn('"sudo oxen-rancher stop"')
      // or should we just return 0?
      process.exit(1)
    }
    console.log('requesting launcher('+pid+') to stop')
    count++
    // hrm 15 doesn't always kill it... (lxc308)
    process.kill(pid, 'SIGTERM') // 15
    // we quit too fast
    //require(__dirname + '/client')(config)
  } else {
    // if no launcher...look for orphans
    var running = getProcessState(config)
    var pids = getPids(config)
    count += stopLokid(config)
    if (config.storage.enabled && running.storageServer) {
      console.log('storage is running, requesting shutdown')
      process.kill(pids.storageServer, 'SIGTERM') // 15
      count++
    }
    if (config.network.enabled && running.lokinet) {
      console.log('network is running, requesting shutdown')
      process.kill(pids.lokinet, 'SIGTERM') // 15
      count++
    }
  }
  return count
}

function waitForLauncherStop(config, cb) {
  var running = getProcessState(config)
  if (running.lokid || running.lokinet || running.storageServer) {
    var wait = 500
    if (running.lokid) wait += 4500
    setTimeout(function() {
      waitForLauncherStop(config, cb)
    }, wait)
    return
  }
  cb()
}

// from https://github.com/yibn2008/find-process/blob/master/lib/find_pid.js (MIT)
const UNIT_MB = 1024 * 1024
const utils = {
  /**
   * exec command with maxBuffer size
   */
  exec (cmd, callback) {
    cp.exec(cmd, {
      maxBuffer: 2 * UNIT_MB,
      windowsHide: true
    }, callback)
  },
  /**
   * spawn command
   */
  spawn (cmd, args, options) {
    return cp.spawn(cmd, args, options)
  },
  /**
   * Strip top lines of text
   *
   * @param  {String} text
   * @param  {Number} num
   * @return {String}
   */
  stripLine (text, num) {
    let idx = 0

    while (num-- > 0) {
      let nIdx = text.indexOf('\n', idx)
      if (nIdx >= 0) {
        idx = nIdx + 1
      }
    }

    return idx > 0 ? text.substring(idx) : text
  },

  /**
   * Split string and stop at max parts
   *
   * @param  {Number} line
   * @param  {Number} max
   * @return {Array}
   */
  split (line, max) {
    let cols = line.trim().split(/\s+/)

    if (cols.length > max) {
      cols[max - 1] = cols.slice(max - 1).join(' ')
    }

    return cols
  },

  /**
   * Extract columns from table text
   *
   * Example:
   *
   * ```
   * extractColumns(text, [0, 2], 3)
   * ```
   *
   * From:
   * ```
   * foo       bar        bar2
   * valx      valy       valz
   * ```
   *
   * To:
   * ```
   * [ ['foo', 'bar2'], ['valx', 'valz'] ]
   * ```
   *
   * @param  {String} text  raw table text
   * @param  {Array} idxes  the column index list to extract
   * @param  {Number} max   max column number of table
   * @return {Array}
   */
  extractColumns (text, idxes, max) {
    let lines = text.split(/(\r\n|\n|\r)/)
    let columns = []

    if (!max) {
      max = Math.max.apply(null, idxes) + 1
    }

    lines.forEach(line => {
      let cols = utils.split(line, max)
      let column = []

      idxes.forEach(idx => {
        column.push(cols[idx] || '')
      })

      columns.push(column)
    })

    return columns
  },

  /**
   * parse table text to array
   *
   * From:
   * ```
   * Header1   Header2    Header3
   * foo       bar        bar2
   * valx      valy       valz
   * ```
   *
   * To:
   * ```
   * [{ Header1: 'foo', Header2: 'bar', Header3: 'bar2' }, ...]
   * ```
   *
   * @param  {String} data raw table data
   * @return {Array}
   */
  parseTable (data) {
    let lines = data.split(/(\r\n|\n|\r)/).filter(line => {
      return line.trim().length > 0
    })

    let matches = lines.shift().trim().match(/(\w+\s*)/g)
    if (!matches) {
      return []
    }
    let ranges = []
    let headers = matches.map((col, i) => {
      let range = []

      if (i === 0) {
        range[0] = 0
        range[1] = col.length
      } else {
        range[0] = ranges[i - 1][1]
        range[1] = range[0] + col.length
      }

      ranges.push(range)

      return col.trim()
    })
    ranges[ranges.length - 1][1] = Infinity

    return lines.map(line => {
      let row = {}
      ranges.forEach((r, i) => {
        let key = headers[i]
        let value = line.substring(r[0], r[1]).trim()

        row[key] = value
      })

      return row
    })
  }
}

const finders = {
  darwin (port) {
    return new Promise((resolve, reject) => {
      utils.exec('netstat -anv -p TCP && netstat -anv -p UDP', function (err, stdout, stderr) {
        if (err) {
          reject(err)
        } else {
          err = stderr.toString().trim()
          if (err) {
            reject(err)
            return
          }

          // replace header
          let data = utils.stripLine(stdout.toString(), 2)
          let found = utils.extractColumns(data, [0, 3, 8], 10)
            .filter(row => {
              return !!String(row[0]).match(/^(udp|tcp)/)
            })
            .find(row => {
              let matches = String(row[1]).match(/\.(\d+)$/)
              if (matches && matches[1] === String(port)) {
                return true
              }
            })

          if (found && found[2].length) {
            resolve(parseInt(found[2], 10))
          } else {
            reject(new Error(`pid of port (${port}) not found`))
          }
        }
      })
    })
  },
  freebsd: 'darwin',
  sunos: 'darwin',
  linux (port) {
    return new Promise((resolve, reject) => {
      let cmd = 'netstat -tunlp'

      utils.exec(cmd, function (err, stdout, stderr) {
        if (err) {
          reject(err)
        } else {
          const warn = stderr.toString().trim()
          if (warn) {
            // netstat -p ouputs warning if user is no-root
            console.warn(warn)
          }

          // replace header
          let data = utils.stripLine(stdout.toString(), 2)
          let columns = utils.extractColumns(data, [3, 6], 7).find(column => {
            let matches = String(column[0]).match(/:(\d+)$/)
            if (matches && matches[1] === String(port)) {
              return true
            }
          })

          if (columns && columns[1]) {
            let pid = columns[1].split('/', 1)[0]

            if (pid.length) {
              resolve(parseInt(pid, 10))
            } else {
              reject(new Error(`pid of port (${port}) not found`))
            }
          } else {
            reject(new Error(`pid of port (${port}) not found`))
          }
        }
      })
    })
  },
  win32 (port) {
    return new Promise((resolve, reject) => {
      utils.exec('netstat -ano', function (err, stdout, stderr) {
        if (err) {
          reject(err)
        } else {
          err = stderr.toString().trim()
          if (err) {
            reject(err)
            return
          }

          // replace header
          let data = utils.stripLine(stdout.toString(), 4)
          let columns = utils.extractColumns(data, [1, 4], 5).find(column => {
            let matches = String(column[0]).match(/:(\d+)$/)
            if (matches && matches[1] === String(port)) {
              return true
            }
          })

          if (columns && columns[1].length && parseInt(columns[1], 10) > 0) {
            resolve(parseInt(columns[1], 10))
          } else {
            reject(new Error(`pid of port (${port}) not found`))
          }
        }
      })
    })
  },
}

function findPidByPort(port) {
  let platform = process.platform

  return new Promise((resolve, reject) => {
    if (!(platform in finders)) {
      return reject(new Error(`platform ${platform} is unsupported`))
    }

    let findPid = finders[platform]
    if (typeof findPid === 'string') {
      findPid = finders[findPid]
    }

    findPid(port).then(resolve, reject)
  })
}

let shuttingDown = false
function httpPost(url, postdata, options, cb) {
  if (cb === undefined && typeof(options) !== 'object'){
    cb = options
    options = {}
  }
  return new Promise(function(resolve, reject) {
    const urlDetails = urlparser.parse(url)
    var protoClient = http
    if (urlDetails.protocol == 'https:') {
      protoClient = https
    }
    // well somehow this can get hung on macos
    var abort = false
    var watchdog = setInterval(function () {
      if (shuttingDown) {
        // [', url, ']
        console.log('LIB: hung httpPost but have shutdown request, calling back early and setting abort flag')
        clearInterval(watchdog)
        abort = true
        if (cb) cb()
        else // so rejecting a non-await cb version is a problem
          reject()
        return
      }
    }, 5000)
    // console.log('url', url, 'postdata', postdata)
    const req = protoClient.request({
      hostname: urlDetails.hostname,
      protocol: urlDetails.protocol,
      port: urlDetails.port,
      path: urlDetails.path,
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postdata.length,
        'Host': 'localhost', // hack for lokinet
        'User-Agent': 'Mozilla/5.0 Loki-launcher/' + VERSION
      }
    }, function (resp) {
      clearInterval(watchdog)

      resp.setEncoding('binary')
      let data = ''
      // A chunk of data has been recieved.
      resp.on('data', (chunk) => {
        data += chunk
      })
      // The whole response has been received. Print out the result.
      resp.on('end', () => {
        // warn if not perfect
        if (resp.statusCode != 200) {
          console.log('LIB: httpPost result code', resp.statusCode)
        }
        if (abort) {
          // we already called back
          return
        }
        // hijack 300s
        if (resp.statusCode === 301 || resp.statusCode === 302) {
          if (resp.headers.location) {
            let loc = resp.headers.location
            if (!loc.match(/^http/)) {
              if (loc.match(/^\//)) {
                // absolute path
                loc = urlDetails.protocol + '//' + urlDetails.hostname + ':' + urlDetails.port + loc
              } else {
                // relative path
                loc = urlDetails.protocol + '//' + urlDetails.hostname + ':' + urlDetails.port + urlDetails.path + loc
              }
            }
            console.log('LIB: httpPost asks for redirect to', loc)
            //return httpPost(loc, postdata, options, cb)
            reject()
          }
        }
        // fail on 400s
        if (resp.statusCode === 404 || resp.statusCode === 403) {
          if (resp.statusCode === 403) console.error('LIB:', url, 'is forbidden')
          if (resp.statusCode === 404) console.error('LIB:', url, 'is not found')
          if (cb) cb()
          else
            reject()
          return
        }
        if (cb) cb(data)
        resolve(data)
      })
    }).on("error", (err) => {
      if (!options.quiet) {
        console.error("LIB: httpPost Error: " + err.message, 'port', urlDetails.port)
      }
      clearInterval(watchdog)
      //console.log('err', err)
      abort = true // because we can get a parse error and then get a response...
      if (cb) cb()
      else
        reject()
    })
    req.write(postdata)
    req.end()
    // I don't think anything uses this
    //return req
  })
}

// FIXME: consider shutdown hooks system
// should that use events?
// statusWatcher in interactive-debug needs shutdown hooks too
function stop() {
  shuttingDown = true
}

async function waitForBlockchain(config, options) {
  return new Promise(function (resolve, reject) {
    let timer
    if (options.timeout) {
      timer = setTimeout(function() {
        reject()
      }, options.timeout)
    }
    function checkChain() {
      runBlockchainRPCTest(config, function(result) {
        if (result) {
          if (timer) clearTimeout(timer)
          return resolve()
        }
        setTimeout(checkChain, 1000)
      })
    }
    checkChain()
  })
}

async function startLokidForRPC(daemon, lokinet, config) {
  daemon.config = config // update config for shutdownEverything

  lokinet.disableLogging(true)
  const publicIPv4 = await lokinet.getPublicIPv4()
  if (!publicIPv4) {
    console.error('LAUNCHER: Could not determine a IPv4 public address for this host.')
    process.exit()
  }
  config.launcher.publicIPv4 = publicIPv4
  const args = []
  const parameters = daemon.configureLokid(config, args)
  const lokid_options = parameters.lokid_options
  //console.log('configured ', config.blockchain.binary_path, lokid_options.join(' '))
  config.blockchain.quiet = true // force quiet
  daemon.launchLokid(config.blockchain.binary_path, lokid_options, false, config, args)
  await waitForBlockchain(config, { timeout: 30 * 1000 })
}

async function runOfflineBlockchainRPC(daemon, lokinet, config, rpcFunc) {
  startLokidForRPC(daemon, lokinet, config)
  await waitForBlockchain(config, { timeout: 30 * 1000 })
  const res = await rpcFunc(config)
  stopLokid(config)
  return res.result ? res.result : res
}


module.exports = {
  getLogo: getLogo,
  //  args: args,
  //  stripArg: stripArg,
  clearStartupLock: clearStartupLock,
  areWeRunning: areWeRunning,
  setStartupLock: setStartupLock,

  isPidRunning: isPidRunning,
  pidUser: pidUser,
  getPids: getPids,
  savePids: savePids,
  clearPids: clearPids,
  findPidByPort: findPidByPort,

  falsish: falsish,
  getProcessState: getProcessState,
  getLauncherStatus: getLauncherStatus,

  stopLauncher: stopLauncher,
  waitForLauncherStop: waitForLauncherStop,

  httpPost: httpPost,
  runStorageRPCTest: runStorageRPCTest,
  stop: stop,
  getBlockchainVersion: getBlockchainVersion,
  getStorageVersion: getStorageVersion,
  getNetworkVersion: getNetworkVersion,

  runOfflineBlockchainRPC: runOfflineBlockchainRPC,
  startLokidForRPC: startLokidForRPC,
  stopLokid: stopLokid,
  blockchainRpcGetKey: blockchainRpcGetKey,
  blockchainRpcGetNetInfo: blockchainRpcGetNetInfo,
  blockchainRpcGetObligationsQuorum: blockchainRpcGetObligationsQuorum,
}
