// no npm!
const fs = require('fs')
const cp = require('child_process')
const execSync = cp.execSync
const spawn = cp.spawn
const lokinet = require(__dirname + '/../lokinet')
const systemd = require(__dirname + '/../src/lib/lib.systemd.js')

function writeServiceFile(nLines, serviceFile) {
  var newBytes = nLines.join("\n")
  fs.writeFileSync(serviceFile, newBytes)
  const found = lokinet.getBinaryPath('systemctl')
  if (found) {
    try {
      execSync('systemctl daemon-reload')
      // FIXME also run:
      // systemctl enable lokid
      // systemctl start lokid? no, we reboot on fresh install
    } catch(e) {
      console.warn('(Error when trying to reload: ', e.message, ') You may need to run: systemctl daemon-reload')
    }
  } else {
    console.log('You may need to run: systemctl daemon-reload')
  }
}

// only should be done as root
function createServiceFile(entrypoint, user) {
  // copy systemd/lokid.service /etc/systemd/system
  const service_bytes = fs.readFileSync(__dirname + '/../systemd/lokid.service')
  var lines = service_bytes.toString().split(/\n/)
  var nLines = []
  for(var i in lines) {
    var tline = lines[i].trim()
    if (tline.match(/^User=/)) {
      tline = 'User=' + user
    }
    if (tline.match(/^ExecStart=/)) {
      tline = 'ExecStart=' + entrypoint + ' systemd-start'
    }
    nLines.push(tline)
  }
  writeServiceFile(nLines, '/etc/systemd/system/lokid.service')
}

function getUser() {
  if (!fs.existsSync('/etc/systemd/system/lokid.service')) {
    return false
  }
  const service_bytes = fs.readFileSync('/etc/systemd/system/lokid.service')
  var lines = service_bytes.toString().split(/\n/)
  var nLines = []
  for(var i in lines) {
    var tline = lines[i].trim()
    if (tline.match(/^User=/)) {
      var parts = tline.split(/=/)
      return parts[1]
    }
  }
}

function rewriteServiceFile(serviceFile, entrypoint) {
  console.log('detected', serviceFile)
  // read file
  const service_bytes = fs.readFileSync(serviceFile)
  var lines = service_bytes.toString().split(/\n/)
  var nLines = []
  var needsBinaryUpdate = false
  var needsNoFileUpdate = true
  for(var i in lines) {
    var tline = lines[i].trim()
    if (tline.match(/^LimitNOFILE=/)) {
      needsNoFileUpdate = false
    }
    if (tline.match(/^ExecStart/)) {
      console.log('ExecStart', tline)
      if (tline.match(/lokid/)) {
        console.log('ExecStart uses lokid directly')
        needsBinaryUpdate = true
        // replace ExecStart
        tline = 'ExecStart=' + entrypoint + ' systemd-start'
      }
      if (tline.match(/loki-launcher/) && !entrypoint.match(/'loki-launcher'/)) {
        console.log('ExecStart uses loki-launcher')
        needsBinaryUpdate = true
        // replace ExecStart
        tline = 'ExecStart=' + entrypoint + ' systemd-start'
      }
    }
    nLines.push(tline)
  }
  // patch up nLines if needed
  if (needsNoFileUpdate) {
    const cLines = [...nLines]
    nLines = []
    for(line of cLines) {
      if (line.match(/\[Service\]/i)) {
        nLines.push(line.trim())
        nLines.push('LimitNOFILE=16384')
        continue
      }
      nLines.push(line.trim())
    }
    //console.log('lines', nLines)
  }
  if (needsBinaryUpdate || needsNoFileUpdate) {
    if (process.getuid() != 0) {
      console.warn('can not update your lokid.service, not running as root, please run with sudo')
    } else {
      console.log('updating lokid.service')
      writeServiceFile(nLines, serviceFile)
      return true
    }
  }
  return false
}

function hasDebsEnabled() {
  // debs install?
  if (fs.existsSync('/lib/systemd/system/loki-node.service')) {
    // systemctl is-enabled loki-node
    let isEnabled = null
    try {
      const out = execSync('systemctl is-enabled loki-node')
      isEnabled = out.toString() !== 'disabled'
    } catch (err) {
      isEnabled = err.stdout.toString().trim() !== 'disabled'
    }
    return isEnabled
  }
  return false
}

// really doesn't need to be async
async function start(config, entrypoint) {
  // could be done externally?
  const lib = require(__dirname + '/../lib')
  // address issue #19
  lib.stopLauncher(config) // currently not async

  if (fs.existsSync('/etc/systemd/system/lokid.service')) {
    rewriteServiceFile('/etc/systemd/system/lokid.service', entrypoint)
  } else {
    console.debug('/etc/systemd/system/lokid.service does not exist.')
    console.error('You may not be running your Service Node as a system Service, please follow the full guide to reconfigure your node')
  }
  /*
  if (fs.existsSync('/lib/systemd/system/loki-node.service')) {
    rewriteServiceFile('/lib/systemd/system/loki-node.service')
  }
  */
  if (hasDebsEnabled()) {
    console.warn('detected a DEBs install, you should not run both the DEBs and the rancher')
    console.log('To disable the DEBs install, please run: sudo systemctl disable --now loki-node.service')
  }
}

function install(config, entrypoint, user) {
  if (hasDebsEnabled()) {
    console.warn('detected a DEBs install, you should not run both the DEBs and the rancher')
    console.log('To disable the DEBs install, please run: sudo systemctl disable --now loki-node.service')
    return
  }

  console.log('ensuring launcher is not running')
  // could be done externally?
  const lib = require(__dirname + '/../lib')
  // address issue #19
  lib.stopLauncher(config) // currently not async

  // ensure service file
  /*
  if (fs.existsSync('/etc/systemd/system/lokid.service')) {
    rewriteServiceFile('/etc/systemd/system/lokid.service', entrypoint)
  } else {
  */
  console.log('creating systemd service file, installing service as', user)
    createServiceFile(entrypoint, user)
  //}
  console.log('loading systemd service file')
  systemd.refreshServices()
  enable(config)
}

function enable(config) {
  console.log('enabling systemd service file on reboot')
  return systemd.serviceEnable('lokid')
}

function disable(config) {
  if (isEnabled(config)) {
    console.log('service file is enabled, disabling it')
    return systemd.serviceDisable('lokid')
  }
  return true
}

function uninstall(config) {
  if (isEnabled(config)) {
    systemd.serviceStop('lokid')
  }
  disable(config)
  if (fs.existsSync('/etc/systemd/system/lokid.service')) {
    console.log('service file exists, deleting it')
    fs.unlinkSync('/etc/systemd/system/lokid.service')
    systemd.refreshServices()
  }
  console.log('uninstall complete')
}

function launcherLogs(config) {
  const stdout = execSync('journalctl -u lokid')
  console.log(stdout.toString())
}

// is running
function isActive() {
  try {
    const stdout = execSync('systemctl is-active lokid')
    return !stdout.toString().match(/inactive/)
  } catch (e) {
    return
  }
}

// can be ran (installed)
function isEnabled(config) {
  if (!fs.existsSync('/etc/systemd/system/lokid.service')) {
    //console.log('isEnabled - no lokid service file')
    return false
  }
  try {
    // and probably should make sure it's using our entrypoint
    // incase there's multiple snode?
    const stdoutShow = execSync('systemctl show lokid')
    //console.log('stdoutShow', stdoutShow.toString())
    if (stdoutShow.toString().includes(config.entrypoint)) {
      //console.log('isEnabled - contains our entrypoint', config.entrypoint)
      return systemd.serviceEnabled('lokid')
    } else {
      console.log('System has systemd service but not for', config.entrypoint)
      // console.log(stdoutShow.toString())
    }
    return false
  } catch (e) {
    console.error('isEnabled - err', e)
    return null
  }
}

// we should take responsible for oxen-rancher related functions

module.exports = {
  start: start, // upgrade/migrate older lokid
  install: install,
  uninstall: uninstall,
  enable: enable,
  disable: disable,
  hasDebsEnabled: hasDebsEnabled,
  launcherLogs: launcherLogs,
  isStartedWithSystemD: isActive,
  isSystemdEnabled: isEnabled,
  createServiceFile: createServiceFile,
  getUser: getUser,
}
