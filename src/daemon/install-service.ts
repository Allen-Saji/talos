import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ServicePlatform = 'darwin' | 'linux'
export type ServiceArtifact = {
  platform: ServicePlatform
  /** Absolute path the service file should be written to. */
  servicePath: string
  /** Rendered service definition (plist or unit). */
  body: string
  /** Commands the user should run after writing the file. */
  followups: string[]
}

export type RenderServiceOpts = {
  /** Absolute path to the talosd executable. */
  binPath: string
  /** Override $HOME — tests + non-default-home installs. */
  home?: string
  /** Override platform — tests. */
  platform?: NodeJS.Platform
  /** Custom log dir for service stdout/stderr. */
  logDir?: string
}

const LABEL = 'com.talos.daemon'

/**
 * Render a launchd plist (macOS) or systemd user unit (Linux) for `talosd`.
 * Throws on unsupported platforms; install-service is a v1-only feature
 * scoped to the two platforms we ship to (per spec F11.5).
 */
export function renderServiceArtifact(opts: RenderServiceOpts): ServiceArtifact {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? os.homedir()
  const logDir = opts.logDir ?? path.join(home, '.local', 'share', 'talos')

  if (platform === 'darwin') {
    const servicePath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
    const body = renderLaunchdPlist({ binPath: opts.binPath, logDir })
    return {
      platform: 'darwin',
      servicePath,
      body,
      followups: [`launchctl load -w "${servicePath}"`, 'launchctl list | grep talos'],
    }
  }

  if (platform === 'linux') {
    const servicePath = path.join(home, '.config', 'systemd', 'user', 'talosd.service')
    const body = renderSystemdUnit({ binPath: opts.binPath, logDir })
    return {
      platform: 'linux',
      servicePath,
      body,
      followups: [
        'systemctl --user daemon-reload',
        'systemctl --user enable --now talosd.service',
        'systemctl --user status talosd.service',
      ],
    }
  }

  throw new Error(
    `unsupported platform "${platform}" — install-service supports darwin and linux only`,
  )
}

/** Write the rendered service file. Creates the parent dir if missing. */
export function writeServiceArtifact(artifact: ServiceArtifact): void {
  fs.mkdirSync(path.dirname(artifact.servicePath), { recursive: true })
  fs.writeFileSync(artifact.servicePath, artifact.body, { encoding: 'utf8', mode: 0o644 })
}

function renderLaunchdPlist(opts: { binPath: string; logDir: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.binPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${opts.logDir}/talosd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${opts.logDir}/talosd.err.log</string>
  <key>WorkingDirectory</key>
  <string>${opts.logDir}</string>
</dict>
</plist>
`
}

function renderSystemdUnit(opts: { binPath: string; logDir: string }): string {
  return `[Unit]
Description=Talos vertical Ethereum agent daemon
After=network.target

[Service]
Type=simple
ExecStart=${opts.binPath}
Restart=on-failure
RestartSec=5
StandardOutput=append:${opts.logDir}/talosd.out.log
StandardError=append:${opts.logDir}/talosd.err.log
WorkingDirectory=${opts.logDir}

[Install]
WantedBy=default.target
`
}
