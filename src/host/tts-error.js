// The one error type the speech service surfaces to the browser. It lives
// apart from tts.js so the Edge client can throw it without importing the
// provider table.

export class TtsError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'TtsError'
    this.code = code
    this.status = status
  }
}
