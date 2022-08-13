const fs = require('fs')
const cp  = require('child_process')
const execSync = cp.execSync

function start(config, options) {
  const filename = options.destPath

  if (fs.existsSync(filename) || (fs.existsSync(filename + '.xz'))) {
    console.log(filename, '(or ' + filename + '.xz) already exists please delete or specify a different file path')
    process.exit()
  }

  execSync('tar -cf ' + filename + ' -T /dev/null')
  //
  function addFile(file, dir) {
    const stripFile = file.replace(dir + '/', '')
    // console.log('strip', dir, 'from', file, '=>', stripFile)
    execSync('tar -C '+dir+' -rf ' + filename + ' ' + stripFile)
  }
  console.log('exporting blockchain keys')
  if (fs.existsSync(config.blockchain.lokid_key)) {
    addFile(config.blockchain.lokid_key, config.blockchain.data_dir)
  }
  if (fs.existsSync(config.blockchain.lokid_edkey)) {
    addFile(config.blockchain.lokid_edkey, config.blockchain.data_dir)
  }
  console.log('exporting network keys')
  addFile(config.network.data_dir + '/encryption.private', config.network.data_dir)
  addFile(config.network.data_dir + '/transport.private', config.network.data_dir)
  // "Shouldn't be very important, it just takes a bit longer to generate them" - Maxim S 200415
  //console.log('saving storage keys')
  console.log('exporting storage data')
  addFile(config.storage.data_dir + '/storage.db', config.storage.data_dir)
  try {
    console.log('trying to compress')
    execSync('xz ' + filename)
    console.log('compressed')
  } catch(e) {
    console.log('xz error, skipping compression')
  }
}

module.exports = {
  start: start,
}
