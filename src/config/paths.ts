import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share')

const dataDir = process.env.TALOS_DATA_DIR ?? path.join(xdgDataHome, 'talos')
const configDir = process.env.TALOS_CONFIG_DIR ?? path.join(xdgConfigHome, 'talos')

export const paths = {
  home,
  dataDir,
  configDir,
  dbPath: path.join(dataDir, 'db'),
  tokenPath: path.join(configDir, 'daemon.token'),
  pidPath: path.join(configDir, 'daemon.pid'),
  channelsConfigPath: path.join(configDir, 'channels.yaml'),
  logPath: path.join(dataDir, 'talos.log'),
  keeperhubTokenPath: path.join(configDir, 'keeperhub.token'),
} as const

export type Paths = typeof paths
