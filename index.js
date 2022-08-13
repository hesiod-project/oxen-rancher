#!/usr/bin/env node
// no npm!
const os = require('os')
const packageData = require('./package.json')
const execSync = require('child_process').execSync

let VERSION = packageData.version
let useGitVersion = false

if (VERSION.match(/git/)) {
  try {
    var stdout = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    if (stdout && stdout.toString) {
      VERSION = stdout.toString().trim()
      useGitVersion = true
    }
  } catch(e) {
    // guessing you don't have git installed...
    //console.warn('git is not installed, can\'t determine revision')
    // silently fail
  }
  continueStart()
} else {
  continueStart()
}

async function continueStart() {
  if (os.platform() == 'darwin') {
    if (process.getuid() != 0) {
      console.error('MacOS requires you start this with sudo, i.e. $ sudo ' + __filename)
      process.exit(1)
    }
  } else {
    // FIXME:
    // ok if you run this once as root, it may create directories as root
    // maybe we should never make dirs as root... (unless macos, ugh)
  }

  // preprocess command line arguments
  var args = JSON.parse(JSON.stringify(process.argv))
  function stripArg(match) {
    var found = false
    for (var i in args) {
      var arg = args[i]
      if (arg == match) {
        args.splice(i, 1)
        found = true
      }
    }
    return found
  }
  // well argvs[0] we will always want to strip...
  stripArg('/usr/local/bin/node')
  stripArg('/usr/local/bin/nodejs')
  stripArg('/usr/bin/node')
  stripArg('/usr/bin/nodejs')
  stripArg('node')
  stripArg('nodejs')
  // centos8
  stripArg('/bin/node')
  stripArg('/bin/loki-launcher')
  stripArg('/bin/oxen-rancher')
  stripArg(__filename) // will just be index.js
  stripArg('loki-launcher')
  stripArg('oxen-rancher')
  stripArg('/usr/bin/loki-launcher')
  stripArg('/usr/local/bin/loki-launcher')
  stripArg('/usr/bin/oxen-rancher')
  stripArg('/usr/local/bin/oxen-rancher')
  // how is this not __filename??
  stripArg('/usr/lib/node_modules/loki-launcher/index.js')
  stripArg('/usr/lib/node_modules/oxen-rancher/index.js')
  //console.debug('index filename:', __filename)
  //console.debug('Launcher arguments:', args)

  function findFirstArgWithoutDash() {
    const outArgs = findAllArgWithoutDashes()
    //console.log('outArgs', outArgs)
    if (!outArgs.length) return ''
    return outArgs[0]
  }
  function findSecondArgWithoutDash() {
    const outArgs = findAllArgWithoutDashes()
    if (outArgs.length < 2) return ''
    return outArgs[1]
  }
  function findAllArgWithoutDashes() {
    const outArgs = []
    //console.log('args', args)
    for(var i in args) {
      var arg = args[i]
      //console.log('arg is', arg)
      if (arg[0] !== '-') outArgs.push(arg)
    }
    return outArgs
  }

  // find the first arg without --
  var modeExtractedFrom = [...args]
  var mode = findFirstArgWithoutDash()

  //console.log('mode', mode)
  stripArg(mode)
  mode = mode.toLowerCase() // make sure it's lowercase

  // load config from disk
  const fs = require('fs')
  const ini = require(__dirname + '/ini')
  const configUtil = require(__dirname + '/config')
  // FIXME: get config dir
  // via cli param
  // via . ?
  var disk_config = {}
  var config = configUtil.getDefaultConfig(__filename)
  var config_type = 'default'
  if (fs.existsSync('/etc/oxen-rancher/rancher.ini')) {
    const ini_bytes = fs.readFileSync('/etc/oxen-rancher/rancher.ini')
    disk_config = ini.iniToJSON(ini_bytes.toString())
    config = disk_config
    config_type = 'etc'
  } else
  if (fs.existsSync('/etc/loki-launcher/launcher.ini')) {
    const ini_bytes = fs.readFileSync('/etc/loki-launcher/launcher.ini')
    disk_config = ini.iniToJSON(ini_bytes.toString())
    config = disk_config
    config_type = 'etc'
  }
  // local overrides default path
  //console.log('test', __dirname + '/launcher.ini')
  if (fs.existsSync(__dirname + '/launcher.ini')) {
    const ini_bytes = fs.readFileSync(__dirname + '/launcher.ini')
    disk_config = ini.iniToJSON(ini_bytes.toString())
    config = disk_config
    config_type = __dirname
  }
  config.type = config_type
  config.entrypoint = __filename

  const lib = require(__dirname + '/lib')

  //console.log('Launcher config:', config)
  // FIXME: do the spelling unification up here
  // interactive, start because user facing and we'll want the version in logs
  // may want to it in '' to give more screen space to help
  const showLogoCommands = [
    'prequal', 'download-binaries', 'version', 'versions', 'config-view', 'client'
  ]
  const showVersionCommands = [
    'prequal', 'interactive', 'start', 'daemon-start'
  ]
  if (showLogoCommands.includes(mode)) {
    if (useGitVersion) {
      var logo = lib.getLogo('git rev version')
      console.log(logo.replace(/version/, VERSION.toString()))
    } else {
      var logo = lib.getLogo('O X E N - R A N C H E R   v e r s i o n   v version')
      console.log(logo.replace(/version/, VERSION.toString().split('').join(' ')))
    }
  }
  if (showVersionCommands.includes(mode)) {
    console.log('Oxen-Rancher version', VERSION.toString())
  }

  var debugMode = mode.match(/debug/i)
  //if (debugMode) console.debug('enabling debug')
  configUtil.check(config, args, debugMode)

  let statusWatcher = false

  const statusSystem = require(__dirname + '/modes/status')
  statusSystem.start(config)

  const systemdUtils = require(__dirname + '/modes/check-systemd')
  async function doInstallUpgrade(user, config, install) {
    // check versions first...
    // what are we running, what do we have installed
    // is there new available?
    // try an npm upgrade...
    const noProblems = await require(__dirname + '/modes/prequal')(config, false)
    if (!noProblems) {
      console.log('please fix these issues before continuing installation')
      process.exit();
    }
    var options = {
      forceDownload: false,
      prerel: false
    }
    await require(__dirname + '/modes/download-binaries').start(config, options)
    if (install) {
      // FIXME: detect if we have any blockchain started
      // and it has to be over 10gb
      // this isn't always faster either... like for Rick
      await require(__dirname + '/modes/download-blockchain').start(config, options)
    }
    // detect upgrade or fresh install
    if (fs.existsSync('/etc/systemd/system/lokid.service')) {
      await systemdUtils.start(config, __filename)
      // ensure it's enabled?
      // they may have intentionally disabled it
      /*
      if (!systemdUtils.isSystemdEnabled(config)) {
        systemdUtils.enable(config)
      }
      */
    } else {
      // this will enable
      systemdUtils.install(config, __filename, user)
    }
    await require(__dirname + '/modes/fix-perms').start(user, __dirname, config)
    // start-debug to test?
    if (systemdUtils.isSystemdEnabled(config)) {
      const stdout = execSync('systemctl start lokid')
    } else {
      // override args
      // not yet...
      // await require(__dirname + '/start')([], config, __filename, false)
    }
    // reboot?
    // start through system
    console.log('Now we recommend you reboot to make sure everything comes back after a reboot event')
    // console.log('Or alternative please run: sudo systemctl start lokid')
    // system takes too long
    //await statusSystem.status()
  }

  // this just show's what's installed not running
  function showVersions() {
    console.log('blockchain installed version', lib.getBlockchainVersion(config))
    console.log('storage    installed version', lib.getStorageVersion(config))
    console.log('network    installed version', lib.getNetworkVersion(config))
  }

  async function getPubKeys() {
    var running = lib.getProcessState(config)
    let keys
    if (running.lokid) {
      const response = await lib.blockchainRpcGetKey(config)
      keys = response.result
    } else {
      console.log('blockchain is not running, one sec, need to start it to get our key')
      const daemon = require(__dirname + '/daemon')
      const lokinet = require('./lokinet')
      keys = await lib.runOfflineBlockchainRPC( daemon, lokinet, config, lib.blockchainRpcGetKey)
    }
    delete keys.status
    return keys
  }

  console.log('Running', mode)
  switch(mode) {
    case 'strt':
    case 'strart':
    case 'staart':
    case 'start': // official
      const installed = systemdUtils.isSystemdEnabled(config)
      if (installed) {
        const restartUser = systemdUtils.getUser()

        // is it already running?
        if (systemdUtils.isStartedWithSystemD()) {
          console.log('Already running in system as', restartUser)
          return
        }
        console.log('starting launcher as', restartUser)
        const systemd = require(__dirname + '/src/lib/lib.systemd.js')
        if (!systemd.serviceStart('lokid')) {
          console.log('Could not start via systemd, likely a permissions problem, run again with sudo')
          console.log('To stop trying to start with systemd run: sudo oxen-rancher systemd disable')
        }
        // wait for start?
      } else {
        warnRunAsRoot()
        require(__dirname + '/start')(args, config, __filename, false)
      }
    break;
    case 'stauts':
    case 'statsu':
    case 'statu':
    case 'stuatus':
    case 'stautu':
    case 'status': // official
      await statusSystem.status()

      var type = findFirstArgWithoutDash()
      if (type) {
        const nodeVer = Number(process.version.match(/^v(\d+\.\d+)/)[1])
        switch(type) {
          case 'blockchain':
            // can hang if lokid is popping blocks
            console.log('BLOCKCHAIN STATUS')
            var status = await statusSystem.checkBlockchain()
            var pubkey = ''
            if (status.pubkey) {
              pubkey += status.pubkey
            }
            delete status.pubkey
            if (nodeVer >= 10) {
              console.table(status)
            } else {
              console.log(status)
            }
            if (pubkey) {
              console.log(`More info: https://oxensn.com/sn/${pubkey}`)
            }
          break;
          case 'storage':
            console.log('STORAGE STATUS')
            var data = await statusSystem.checkStorage()
            if (data.storageServerStatus === false) {
              console.log('failure')
            } else {
              console.log('looks good')
            }
          break;
          case 'network':
            console.log('NETWORK STATUS')
            statusSystem.checkNetwork()
          break;
        }
      }
    break;
    case 'show-quorum':
      if (configUtil.isBlockchainBinary7X(config)) {
        var ver = lib.getBlockchainVersion(config)
        if (ver.match(/7.1.0|7.1.1|7.1.2|7.1.3/)) {
          console.log('ver', ver, 'has a bug and this function will not work')
          process.exit()
        }
      }
      var running = lib.getProcessState(config)
      var keys, qResp, info
      if (!running.lokid) {
        const daemon = require(__dirname + '/daemon')
        const lokinet = require('./lokinet')
        console.log('blockchain is not running, one sec, need to start it')
        await lib.startLokidForRPC(daemon, lokinet, config)
      }

      keys = await lib.blockchainRpcGetKey(config)
      if (!keys || !keys.result || !keys.result.service_node_pubkey) {
        console.error('Could not get our pubkey')
        return
      }
      const ourPubKey = keys.result.service_node_pubkey
      console.log('Our PubKey', ourPubKey)

      info = await lib.blockchainRpcGetNetInfo(config)
      if (info && info.result && info.result.height) {
        const startHeight = info.result.height - 11
        const endHeight = info.result.height
        // full node just has quorums up to endHeight
        console.log('Network height:', info.result.height, 'Checking for quorums between', startHeight, 'to', endHeight)
        const knownQuorums = {}
        qResp = await lib.blockchainRpcGetObligationsQuorum(config, {
          start_height: startHeight,
          end_height: endHeight,
        })
        if (!qResp) {
          console.error('no quorum resp for', adjusedHeight)
          return
        }
        // console.log('checking height', adjusedHeight, qResp.result.quorums[0].height, qResp.result.quorums[0].quorum_type, qResp.result.quorums[0])
        const obligations = qResp.result.quorums.filter(q => q.quorum_type === 0)
        if (!obligations.length) {
          console.error('Could not find any obligation quorums, try again later')
          return
        }

        console.warn('There are', obligations.length, 'quorums found')
        let found = false
        const heights = []
        obligations.forEach(test => {
          /*
          if (knownQuorums[test.height]) {
            continue
          }
          knownQuorums[next.height] = true
          */
          heights.push(test.height)
          // console.log('test:', test)
          // height isn't set if we just started it up
          if (test.quorum.workers.indexOf(ourPubKey) !== -1) {
            const blocks = test.height - (info.result.height - 11)
            console.log('You will be tested at', test.height, 'which is roughly in', blocks * 2, 'mins')
            found = true
          }
        })
        if (!found) {
          console.warn('Could not find you being tested in', heights)
          console.log('Please run again in a little bit (2 mins+)')
        }
      }

      if (!running.lokid) {
        lib.stopLokid(config)
      }

      if (!qResp) {
        console.error('no quorum resp')
        return
      }
    break;
    case 'key':
    case 'keys':
      var keys = await getPubKeys()
      console.log(keys)
    break;
    // no restart because we don't want people croning it
    case 'sotp':
    case 'stp':
    case 'stop': // official
      // maybe use the client to see what's taking lokid a while...
      //console.log('Getting launcher state')
      lib.stopLauncher(config)
      function shutdownMonitor() {
        var running = lib.getProcessState(config)
        var pid = lib.areWeRunning(config)
        var waiting = []
        if (pid) {
          waiting.push('launcher')
        }
        if (running.lokid) {
          waiting.push('blockchain')
        }
        if (running.lokinet) {
          waiting.push('network')
        }
        if (running.storageServer) {
          waiting.push('storage')
        }
        if (running.lokid || running.lokinet || running.storageServer) {
          console.log('Shutdown waiting on', waiting.join(' '))
          setTimeout(shutdownMonitor, 1000)
        } else {
          console.log('Successfully shutdown.')
        }
      }

      var pid = lib.areWeRunning(config)
      if (!pid) {
        // launcher isn't running but asking for stop...
        const lokinet = require('./lokinet')
        // TODO: lokinet running? can't check udp. loki-storage port running?
        // TODO: launcher actually running somewhere?
        // and is it locked up? webserver port?
        lokinet.portIsFree(config.blockchain.rpc_ip, config.blockchain.rpc_port, async function(portFree) {
          if (!portFree) {
            const portPid = await lib.findPidByPort(config.blockchain.rpc_port)
            console.log('')
            console.log(`There's a oxend on ${portPid} that we're not tracking using our configuration (rpc_port is already in use). You likely will want to confirm and manually stop it before start using the rancher again.`);
            console.log('')
          }
        })
      }

      var running = lib.getProcessState(config)
      var wait = 500
      if (running.lokid) wait += 4500
      if (running.lokid || running.lokinet || running.storageServer) {
        console.log('Waiting for daemons to stop.')

        const net = require('net')

        var socketPath = config.launcher.var_path + '/launcher.socket'
        if (fs.existsSync(socketPath)) {
          console.log('Trying to connect to', socketPath)
          // FIXME: file exist check


          const client = net.createConnection({ path: socketPath }, () => {
            // 'connect' listener
            //console.log('Connected to server!')
          })
          client.on('error', (err) => {
            if (err.code == 'EPERM') {
              console.warn('It seems user', process.getuid(), 'does not have the required permissions to view socket while blockchain stops')
            } else
            if (err.code == 'ECONNREFUSED') {
              console.warn('Can not connect to', socketPath, 'connection is refused')
            } else {
              console.warn('client socket err', err)
            }
          })
          client.on('data', (data) => {
            var stripped = data.toString().trim().replace(/\n/, '')
            console.log('FROM SOCKET:', stripped)
          })
          client.on('end', () => {
            console.log('Disconnected from socket server...')
            //process.exit()
          })
        }

        setTimeout(shutdownMonitor, wait)
      } else {
        console.log('No processes to shutdown')
      }
    break;
    case 'start-debug':
      // no interactive or docker
      config.launcher.cimode = true
      // debug mode basically (but also used internally now)
      process.env.__daemon = true
      require(__dirname + '/start')(args, config, __filename, true)
    break;
    case 'interactive-debug':
    case 'ineractive':
    case 'interactive':
      config.launcher.interactive = true
      process.env.__daemon = true
      /*
      if (debugMode) {
        statusWatcher = setInterval(status, 30*1000)
        process.on('SIGUSR1', function () {
          console.log('Disabling statusWatcher')
          clearInterval(statusWatcher)
        })
        process.on('SIGUSR2', function () {
          console.log('Enabling statusWatcher')
          statusWatcher = setInterval(status, 30*1000)
        })
        // lokid exit seems fine...
        // ctrl-c seems fine too
        process.on('SIGTERM', function () {
          console.log('interactive SIGTERM')
          if (statusWatcher) {
            clearInterval(statusWatcher)
            statusWatcher = false
          }
        })
        process.on('SIGINT', function () {
          console.log('interactive SIGINT')
          if (statusWatcher) {
            clearInterval(statusWatcher)
            statusWatcher = false
          }
          process.exit();
        })
      }
      */
      require(__dirname + '/start')(args, config, __filename, debugMode)
    break;
    case 'daemon-start-debug': // official
    case 'daemon-start': // official
      // debug mode basically (but also used internally now)
      // how this different from systemd-start?
      // this allows for interactive mode...
      process.env.__daemon = true
      require(__dirname + '/start')(args, config, __filename, debugMode)
    break;
    case 'non-interactive':
    case 'systemd-start-debug':
    case 'systemd-start': // official
      // stay in foreground mode...
      // force docker mode...
      // somehow I don't like this hack...
      // what we if reload config from disk...
      // treat it like an CLI arg
      config.launcher.docker = true
      process.env.__daemon = true
      require(__dirname + '/start')(args, config, __filename, debugMode)
    break;
    case 'config-build': // official
      // build a default config
      // commit it to disk if it doesn't exist
    break;
    case 'config-view': // official
      console.log('Oxen-Rancher is in', __dirname)
      // FIXME: prettyPrint
      console.log('Rancher stored-config:', config)
      var pids = lib.getPids(config)
      if (pids && pids.runningConfig) {
        console.log('Rancher running-config:', pids.runningConfig)
      }
    break;
    case 'config-edit': // official
      // xdg-open / open ?
    break;
    case 'client': // deprecated
    case 'console': // official
      // enable all 3
    case 'blockchain':
      require(__dirname + '/modes/client')(config)
    break;
    case 'preuqal':
    case 'prequal': // official
      require(__dirname + '/modes/prequal')(config, false)
    break;
    case 'prequal-debug': // official
      require(__dirname + '/modes/prequal')(config, true)
    break;
    case 'bwtest':
    case 'bw-test': // official
      require(__dirname + '/modes/bw-test').start(config, false)
    break;
    case 'bw-test-debug': // official
      require(__dirname + '/modes/bw-test').start(config, true)
    break;
    case 'check-systemd':
    case 'upgrade-systemd': // official
      requireRoot()
      // we should run this even if it's not enabled
      // as people maybe installing this file for the first time
      systemdUtils.start(config, __filename)
    break;
    case 'systemd':
      var type = findFirstArgWithoutDash()
      if (type === 'install') {
        // need a user params
        requireRoot()
        const user = findSecondArgWithoutDash()
        if (!user) {
          console.log('No user passed in! You must explicitly tell us what user you want to run the rancher as, `snode` is commonly used')
          console.log('You are currently logged in as', os.userInfo().username)
          return
        }
        systemdUtils.install(config, __filename, user)
      } else
      if (type === 'enable') {
        requireRoot()
        if (systemdUtils.enable(config)) {
          console.log('systemd starting is enabled')
        }
      } else
      // bring an service node service file up to date
      if (type === 'upgrade') {
        requireRoot()
        // need __filename for index location to put in service file
        systemdUtils.start(config, __filename)
      } else
      if (type === 'check') {
        if (!fs.existsSync('/etc/systemd/system/lokid.service')) {
          console.log('Will launch on restart: no, not installed')
        } else {
          const restartUser = systemdUtils.getUser()
          console.log('Installed to run as:', restartUser)
          const installed = systemdUtils.isSystemdEnabled(config)
          const sysdrunning = systemdUtils.isStartedWithSystemD()
          console.log('Will launch on restart:', installed ? 'yes' : 'no')
          if (fs.existsSync('/etc/systemd/system/lokid.service')) {
            console.log('Is currently running under systemd:', sysdrunning ? 'yes' : 'no')
          }
        }
      } else
      if (type === 'disable') {
        requireRoot()
        if (require(__dirname + '/modes/check-systemd').disable(config)) {
          console.log('systemd starting is disabled')
        }
      } else
      if (type === 'uninstall' || type === 'unistall' || type === 'uninstalll') {
        requireRoot()
        require(__dirname + '/modes/check-systemd').uninstall(config)
      } else
      if (type === 'log') {
        require(__dirname + '/modes/check-systemd').launcherLogs(config)
      } else {
        console.log('requires one of the following parameters: install, enable, upgrade, check, disable, uninstall or log')
      }
    break;
    case 'debs':
      var type = findFirstArgWithoutDash()
      if (type === 'installed') {
        console.log(require(__dirname + '/modes/debs.js').areInstalled())
      } else
      if (type === 'install' || type === 'enable') {
        await require(__dirname + '/modes/debs.js').enable(config)
      } else
      if (type === 'disable') {
        // FIXME: going to need to know user
        await require(__dirname + '/modes/debs.js').disable(config)
        //
        //await doInstallUpgrade(user, config, true)
      }
    break;
    case 'chown':
    case 'fixperms':
    case 'setperms':
    case 'set-perms':
    case 'fix-perms': // official
      var user = findFirstArgWithoutDash()
      if (!user) {
        console.log('No user passed in! You must explicitly tell us what user you want the permissions to be set for')
        console.log('You are currently logged in as', os.userInfo().username)
        return
      }
      if (process.getuid() != 0) {
        console.log('Fix-perms needs to be ran as root, try prefixing your attempted command with: sudo')
        process.exit(1)
      }
      require(__dirname + '/modes/fix-perms').start(user, __dirname, config)
    break;
    case 'args-debug': // official
      console.log('in :', process.argv)
      console.log('out:', args)
    break;
    case 'donwload-binaries':
    case 'donwload-binaries':
    case 'donwload-bianres':
    case 'download-binares':
    case 'downlaod-binaries':
    case 'downloa-binaries':
    case 'dlb':
    case 'dowload-binaries':
    case 'downloadb-inaries':
    case 'download-binaries': // official
      // because of lokinet and mkdirp /opt/...
      requireRoot()
      var opt1 = findFirstArgWithoutDash()
      // FIXME: prerel-force
      var options = {
        forceDownload: (opt1 === 'force' || opt1 === 'force-prerel'),
        prerel: (opt1 === 'prerel' || opt1 === 'force-prerel')
      }
      await require(__dirname + '/modes/download-binaries').start(config, options)
      require(__dirname + '/modes/check-systemd').start(config, __filename)
    break;
    case 'download-chain':
    case 'download-blockchain': // official
      // FIXME: disable if not mainnet
      // doesn't have to be root but does have to be stopped
      var options = {}
      require(__dirname + '/modes/download-blockchain').start(config, options)
    break;
    case 'export': // official
      // doesn't have to be root or stopped, just need read access
      var oldKey = config.blockchain.lokid_key
      var edKey = config.blockchain.lokid_edkey
      if (!fs.existsSync(oldKey) && !fs.existsSync(edKey)) {
        console.log(oldKey, 'and', edKey, "do not exist, this has not been run as a service node yet")
        process.exit()
      }

      var opt1 = findFirstArgWithoutDash()

      let key
      if (!opt1) {
        const keys = await getPubKeys()
        key = keys.pubkey || keys.service_node_pubkey
      }
      const date = new Date().toISOString().replace(/:/g, '-')

      var options = {
        destPath: opt1 || 'export_' + key + '_' + date + '.tar'
      }
      require(__dirname + '/modes/export').start(config, options)
    break;
    case 'import': // official
      var importFile = findFirstArgWithoutDash()
      if (!importFile) {
        console.log('No file passed in! You must explicitly tell us what file you want imported')
        return
      }
      var options = {
        srcPath: importFile
      }
      require(__dirname + '/modes/import').start(config, options)
    break;
    case 'install': // official
      var user = findFirstArgWithoutDash()
      if (!user) {
        console.log('No user passed in! You must explicitly tell us what user you want the permissions to be set for')
        console.log('You are currently logged in as', os.userInfo().username)
        return
      }
      if (process.getuid() != 0) {
        console.log('install needs to be ran as root, try prefixing your attempted command with: sudo')
        process.exit(1)
      }
      await doInstallUpgrade(user, config, true)
    break;
    case 'upgrade': // official
      var user = systemdUtils.getUser()
      if (!user) {
        user = findFirstArgWithoutDash()
        if (!user) {
          console.log('Not sure what user you want to run things under, you must explicitly tell us what user you want the permissions to be set for as a paraemter to this command')
          console.log('You are currently logged in as', os.userInfo().username)
          return
        }
      }
      if (process.getuid() != 0) {
        console.log('install needs to be ran as root, try prefixing your attempted command with: sudo')
        process.exit(1)
      }
      await doInstallUpgrade(user, config, false)
    break;
    case 'versions':
    case 'version': // official
      showVersions()
    break
    case 'help': // official
    case 'hlep':
    case 'hepl':
    case 'lpeh':
    default:
      console.debug('in :', process.argv)
      console.debug('out:', args, 'mode pulled from:', modeExtractedFrom)
      //              storage    - get storage status
      console.log(`
  Unknown command [${mode}]

  oxen-rancher is manages the oxen.network suite of software primarily for service node operation
  Usage:
    [sudo] oxen-rancher [command] [OPTIONS]

    Commands:
      start       start the oxen suite with OPTIONS (requires sudo if in systemd mode)
      stop        stops the launcher running in the background
      status      get the current oxen suite status, can optionally provide:
                    blockchain - get blockchain status
      client      connect to oxend
      prequal     prequalify your server for service node operation
      config-view print out current configuration information
      versions    show installed versions of oxen software
      systemd     requires one of the following options
                    check - get systemd status
                    log - show systemd rancher log file
      keys        get your service node public keys
      show-quorum tries to give an estimate to the next time you're tested
      export [FILENAME]   try to create a compressed tarball with all the snode files
                            that you need to migrate this snode to another host
      import FILENAME     try to import this exported tarball to this host
      download-blockchain deletes current blockchain and downloads a fresh sync'd copy
                            usually much faster than a normal oxend sync takes

    Commands that require root/sudo:
      download-binaries - download the latest version of the oxen software suite
        can optionally provide: force, prerel and force-prerel
      systemd     requires one of the following options
                    install - make launcher start on reboot
                    enable - enable systemd mode
                    upgrade - make sure your service file is up to date
                    disable - disable systemd mode
                    uninstall - don't start launcher on reboot
      fix-perms - requires user OPTION, make all operational files own by user
      install   - requires user OPTION, installs a fresh node
      upgrade   - upgrade an existing node, may require user OPTION
  `)
    break;
  }
}

function warnRunAsRoot() {
  if (os.platform() != 'darwin') {
    if (process.getuid() === 0) {
      console.error('Its not recommended you run this as root unless the guide otherwise says to do so')
    }
  }
}

function requireRoot() {
  if (process.getuid() !== 0) {
    console.error('This now requires to be ran as root (currentUID:', process.getuid(), ', expected 0), try running the command with "sudo " in front')
    process.exit()
  }
}

// from https://www.codedrome.com/the-soundex-algorithm-in-javascript/
function soundex(name) {
  let s = [];
  let si = 1;
  let c;

  //              ABCDEFGHIJKLMNOPQRSTUVWXYZ
  const mappings = "01230120022455012623010202";

  s[0] = name[0].toUpperCase();

  for(let i = 1, l = name.length; i < l; i++) {
    c = (name[i].toUpperCase()).charCodeAt(0) - 65;

    if(c >= 0 && c <= 25) {
      if(mappings[c] != '0') {
        if(mappings[c] != s[si-1]) {
          s[si] = mappings[c];
          si++;
        }

        if(si > 3) {
          break;
        }
      }
    }
  }

  if(si <= 3) {
    while(si <= 3) {
      s[si] = '0';
      si++;
    }
  }

  return s.join("");
}
