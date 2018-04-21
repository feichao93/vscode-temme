import { window, StatusBarItem, StatusBarAlignment } from 'vscode'

let frameIndex = 0
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function spinner() {
  return frames[frameIndex++ % frames.length]
}

export default class StatusBarController {
  private item: StatusBarItem
  private cancelButton: StatusBarItem
  private handle: any

  constructor() {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 2)
    this.cancelButton = window.createStatusBarItem(StatusBarAlignment.Left, 1)
    this.cancelButton.text = '$(circle-slash)'
    this.cancelButton.command = 'temme.stopWatch'

    this.setText('ready', false)
  }

  setText(text: string, showSpinner: boolean) {
    if (showSpinner) {
      clearInterval(this.handle)
      this.handle = setInterval(() => {
        this.item.text = `${spinner()} temme: ${text}`
      }, 50)
      this.item.show()
      this.cancelButton.show()
    } else {
      this.item.text = `temme: ${text}`
      this.item.show()
      this.cancelButton.hide()
    }
  }

  hide() {
    this.item.hide()
    this.cancelButton.hide()
    clearInterval(this.handle)
  }

  dispose() {
    this.item.dispose()
    this.cancelButton.dispose()
    clearInterval(this.handle)
  }
}
