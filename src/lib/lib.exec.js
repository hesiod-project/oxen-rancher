const cp = require('child_process')
const execSync = cp.execSync

function execOut(cmd) {
  let stdout
  try {
    stdout = execSync(cmd + ' 2>&1')
    //console.log('exit0,', stdout.toString())
    return stdout.toString()
  } catch(e) {
    //console.error(e)
    stdout = e.stdout
    if (stdout.toString) {
      //console.log('exit!0,', stdout.toString())
      return stdout.toString()
    }
  }
  return null
}

module.exports = {
  execOut
}
