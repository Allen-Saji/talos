export class TalosError extends Error {
  public readonly code: string
  public override readonly cause?: unknown

  constructor(message: string, code: string, cause?: unknown) {
    super(message)
    this.name = 'TalosError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export class TalosAuthError extends TalosError {
  constructor(message: string, cause?: unknown) {
    super(message, 'AUTH_ERROR', cause)
    this.name = 'TalosAuthError'
  }
}

export class TalosConfigError extends TalosError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_ERROR', cause)
    this.name = 'TalosConfigError'
  }
}

export class TalosNotImplementedError extends TalosError {
  constructor(feature: string) {
    super(`not implemented: ${feature}`, 'NOT_IMPLEMENTED')
    this.name = 'TalosNotImplementedError'
  }
}

export class TalosProtocolError extends TalosError {
  constructor(message: string, cause?: unknown) {
    super(message, 'PROTOCOL_ERROR', cause)
    this.name = 'TalosProtocolError'
  }
}

export class TalosDbError extends TalosError {
  constructor(message: string, code = 'DB_ERROR', cause?: unknown) {
    super(message, code, cause)
    this.name = 'TalosDbError'
  }
}
