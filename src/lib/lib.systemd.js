// no npm!
const cp = require('child_process')
const execSync = cp.execSync
const spawn = cp.spawn
const libexec = require('./lib.exec.js')

function systemdExists(service) {
  let stdout
  try {
    stdout = execSync('systemctl is-enabled ' + service + ' 2>&1')
    //console.log('exit0,', stdout.toString())
    return !!stdout.toString().match(/enabled|disabled/)
  } catch(e) {
    //console.error(e)
    stdout = e.stdout
    if (stdout.toString) {
      //console.log('exit!0,', stdout.toString())
      return !!stdout.toString().match(/enabled|disabled/)
    }
  }
  return null
}

function systemdIsEnabled(service) {
  let stdout
  try {
    stdout = execSync('systemctl is-enabled ' + service + ' 2>&1')
    return !!stdout.toString().match(/enabled/)
  } catch(e) {
    //console.error(e)
    stdout = e.stdout
    if (stdout.toString) {
      //console.log('exit!0,', stdout.toString())
      return !!stdout.toString().match(/enabled/)
    }
  }
}

function isActive(service) {
  try {
    const stdout = execSync('systemctl is-active ' + service + ' 2>&1')
    return !stdout.toString().match(/inactive/)
  } catch (e) {
    return
  }
}

// requires root
function serviceStart(service) {
  const out = libexec.execOut('systemctl start ' + service)
  //console.log('serviceStart', out)
/*
Job for loki-node.service failed because the control process exited with error code.
See "systemctl status loki-node.service" and "journalctl -xe" for details.

Failed to start lokid.service: The name org.freedesktop.PolicyKit1 was not provided by any .service files
See system logs and 'systemctl status lokid.service' for details.
otherwise quiet
*/
  return !out.match(/failed/i)
}

// requires root
function serviceStop(service) {
  const out = libexec.execOut('systemctl stop ' + service)
  // silent whether it's stopped or not
  //console.log('serviceStop', out)
  return out
}

// requires root
function serviceEnable(service) {
  const out = libexec.execOut('systemctl enable ' + service)
  // Created symlink /etc/systemd/system/multi-user.target.wants/loki-node.service → /lib/systemd/system/loki-node.service.
  //console.log('serviceEnable', out)
  return out.match(/Created symlink /)
}

// requires root
function serviceDisable(service) {
  const out = libexec.execOut('systemctl disable ' + service)
  // Removed /etc/systemd/system/multi-user.target.wants/loki-node.service.
  //console.log('serviceDisable', out)
  return out.match(/Removed /)
}
// requires root
function refreshServices() {
  const out = libexec.execOut('systemctl daemon-reload')
  // no out on sucess
  return out
}

// from (MIT) https://github.com/nmorsman/node-systemd-notify/blob/master/notify.js
function generateArgs(opts) {
  const result = []

  if (('ready' in opts) && (opts.ready === true)) {
    result.push('--ready')
  }

  if ('pid' in opts) {
    result.push(`--pid=${opts.pid}`)
  }
  else if (('ready' in opts) || ('status' in opts)) {
    /**
     * Always send PID to avoid possible race condition
     * https://www.pluralsight.com/tech-blog/using-systemd-notify-with-nodejs/
     */

    result.push(`--pid=${process.pid}`)
  }

  if ('status' in opts) {
    result.push(`--status=${opts.status}`)
  }

  if (('booted' in opts) && (opts.booted === true)) {
    result.push('--booted')
  }

  return result
}

function notifySystemd(opts = {}, callback) {
  return new Promise((resolve, reject) => {
    const args = generateArgs(opts)
    const cmd = spawn('systemd-notify', args)

    let stdout = ''
    let stderr = ''
    let hasCalledBack = false

    cmd.stdout.on('data', (d) => { stdout += d })
    cmd.stderr.on('data', (d) => { stderr += d })

    cmd.on('error', (err) => {
      if (hasCalledBack) {
        return null
      }

      hasCalledBack = true
      return (typeof callback === 'function') ? callback(err) : reject(err)
    })

    cmd.on('close', (code) => {
      if (hasCalledBack) {
        return null
      }

      hasCalledBack = true

      if (code !== 0) {
        const err = stderr.trim() || stdout.trim()
        return (typeof callback === 'function') ? callback(err) : reject(err)
      }

      return (typeof callback === 'function') ? callback(null, cmd) : resolve(cmd)
    })
  })
}

module.exports = {
  serviceExists: systemdExists,
  serviceEnabled: systemdIsEnabled,
  serviceStop,
  serviceStart,
  serviceEnable,
  serviceDisable,
  refreshServices,
  notify: notifySystemd
}
