import EventEmitter from 'events'
import fs from 'fs'
import path from 'path'
import temme, { cheerio, temmeParser } from 'temme'
import {
  commands,
  Diagnostic,
  DiagnosticCollection,
  ExtensionContext,
  languages,
  OutputChannel,
  Position,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  ViewColumn,
  window,
  workspace,
  WorkspaceEdit,
} from 'vscode'
import StatusBarController from './StatusBarController'
import { TAGGED_LINK_PATTERN, TEMME_MODE } from './constants'
import TemmeCodeActionProvider from './TemmeCodeActionProvider'
import TemmeDocumentSymbolProvider from './TemmeDocumentSymbolProvider'
import { downloadHtmlFromLink } from './utils'

type Status = 'ready' | 'running' | 'watching'

let log: OutputChannel
let emitter: EventEmitter
let diagnosticCollection: DiagnosticCollection
let status: Status
let changeCallback: any
let closeCallback: any
let statusBarController: StatusBarController

/** 解析文档中的 temme 选择器，并报告选择器语法错误 */
function detectAndReportTemmeGrammarError(temmeDoc: TextDocument) {
  try {
    temmeParser.parse(temmeDoc.getText())
    diagnosticCollection.delete(temmeDoc.uri)
  } catch (e) {
    let start: Position
    let end: Position
    if (e.location != null && e.location.start != null && e.location.end != null) {
      start = new Position(e.location.start.line - 1, e.location.start.column - 1)
      const endLine = e.location.end.line - 1
      end = new Position(endLine, temmeDoc.lineAt(endLine).text.length)
    } else {
      // 如果错误位置无法确定的话，就使用第一行
      start = new Position(0, 0)
      end = new Position(0, temmeDoc.lineAt(0).text.length)
    }
    diagnosticCollection.set(temmeDoc.uri, [new Diagnostic(new Range(start, end), e.message)])
  }
}

/** 从temme文档中挑选链接。
 * 如果文档中没有链接，则什么也不做
 * 如果文档中只有一个链接，则直接使用该链接
 * 如果文档中有多个链接，则弹出快速选择框让用户进行选择
 * */
async function pickLink(temmeDoc: TextDocument) {
  const taggedLinks: { tag: string; link: string }[] = []

  const lineCount = temmeDoc.lineCount
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const line = temmeDoc.lineAt(lineIndex)
    const match = line.text.match(TAGGED_LINK_PATTERN)
    if (match) {
      taggedLinks.push({
        tag: match[1],
        link: match[2].trim(),
      })
    }
  }

  if (taggedLinks.length === 0) {
    window.showInformationMessage('No link is found in current file.')
    return
  } else if (taggedLinks.length === 1) {
    return taggedLinks[0].link
  } else {
    const options = taggedLinks.map(({ tag, link }) => `${tag} ${link}`)
    const result = await window.showQuickPick(options, { placeHolder: 'Choose an url:' })
    if (result) {
      return taggedLinks[options.indexOf(result)].link
    }
  }
}

async function getLink(link?: string) {
  const editor = window.activeTextEditor
  if (editor == null) {
    window.showWarningMessage('No file opened.')
    return
  }
  const document = editor.document
  if (document.languageId !== 'temme') {
    window.showWarningMessage('Not a temme file.')
    return
  }
  if (link == null) {
    link = await pickLink(document)
  }
  return link
}

async function runSelector(link?: string) {
  link = await getLink(link)
  if (link == null) {
    return
  }
  const document = window.activeTextEditor!.document

  try {
    status = 'running'
    statusBarController.setText('running', false)
    const html = await downloadHtmlFromLink(link)
    const result = temme(html, document.getText())
    const outputContent = JSON.stringify(result, null, 2)
    const outputFileName = path.resolve(document.uri.fsPath, '../', `${document.fileName}.json`)
    fs.writeFileSync(outputFileName, outputContent, 'utf8')

    const outputDocument = await workspace.openTextDocument(Uri.file(outputFileName))
    const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
    if (!visibleDocs.has(outputDocument)) {
      await window.showTextDocument(outputDocument, ViewColumn.Two)
    }
    await window.showInformationMessage('Success')
  } catch (e) {
    window.showErrorMessage(e.stack || e.message)
  } finally {
    status = 'ready'
    statusBarController.setText('ready', false)
  }
}

async function startWatch(link?: string) {
  stopWatch()
  const editor = window.activeTextEditor
  if (editor == null) {
    return
  }
  const temmeDocument = editor.document
  if (temmeDocument.languageId !== 'temme') {
    return
  }

  link = await getLink(link)
  if (link == null) {
    return
  }

  try {
    status = 'watching'
    statusBarController.setText('watching', true)

    const html = await downloadHtmlFromLink(link)
    const $ = cheerio.load(html, { decodeEntities: false })

    const outputFileName = path.resolve(
      temmeDocument.uri.fsPath,
      '../',
      `${temmeDocument.fileName}.json`,
    )
    const outputDocument = await workspace.openTextDocument(Uri.file(outputFileName))
    const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
    if (!visibleDocs.has(outputDocument)) {
      await window.showTextDocument(outputDocument, ViewColumn.Two)
    }

    async function onThisTemmeDocumentChange(changedLine: number) {
      try {
        const selector = temmeDocument.getText()
        const range = new Range(0, 0, outputDocument.lineCount, 0)
        const result = temme($, selector)
        const newText = JSON.stringify(result, null, 2)
        const edit = new WorkspaceEdit()
        edit.replace(outputDocument.uri, range, newText)
        await workspace.applyEdit(edit)
      } catch (e) {
        if (e.name !== 'SyntaxError') {
          // TODO 错误不一定当前编辑的这一行 或第一行
          diagnosticCollection.set(temmeDocument.uri, [
            new Diagnostic(new Range(changedLine, 0, changedLine + 1, 0), e.message),
          ])
        }
        log.appendLine(e.message)
      }
    }

    closeCallback = async function() {
      log.appendLine(
        'text-docs: ' +
          workspace.textDocuments.map(doc => workspace.asRelativePath(doc.uri)).join(', '),
      )
      log.appendLine(
        'visible-docs: ' +
          window.visibleTextEditors
            .map(editor => workspace.asRelativePath(editor.document.uri))
            .join(', '),
      )
      if (!workspace.textDocuments.some(doc => doc === outputDocument)) {
        log.appendLine('Output document closed. Stopping Watch mode...')
        stopWatch()
      }
    }
    changeCallback = async function({ document, contentChanges }: TextDocumentChangeEvent) {
      if (document === temmeDocument) {
        await onThisTemmeDocumentChange(contentChanges[0].range.start.line)
      }
    }

    emitter.addListener('did-change-active-text-editor', closeCallback)
    emitter.addListener('did-change-text-document', changeCallback)

    // 手动触发更新
    await onThisTemmeDocumentChange(0)
  } catch (e) {
    window.showErrorMessage(e.message)
    log.appendLine(e.stack || e.message)
  }
}

function stopWatch() {
  log.appendLine('stopWatch ' + status)
  if (status === 'watching') {
    emitter.removeListener('did-change-active-text-editor', closeCallback)
    emitter.removeListener('did-change-text-document', changeCallback)
    closeCallback = null
    changeCallback = null
    status = 'ready'
    statusBarController.setText('idle', false)
  }
  // TODO if (status === 'running') ???
}

export function activate(ctx: ExtensionContext) {
  status = 'ready'
  log = window.createOutputChannel('temme')
  log.show() // TODO remove this line

  emitter = new EventEmitter()
  diagnosticCollection = languages.createDiagnosticCollection('temme')
  statusBarController = new StatusBarController()

  ctx.subscriptions.push(
    commands.registerCommand('temme.runSelector', runSelector),
    commands.registerCommand('temme.startWatch', startWatch),
    commands.registerCommand('temme.stopWatch', stopWatch),
    languages.registerDocumentSymbolProvider(TEMME_MODE, new TemmeDocumentSymbolProvider()),
    languages.registerCodeActionsProvider(TEMME_MODE, new TemmeCodeActionProvider()),
    workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'temme') {
        emitter.emit('did-change-text-document', event)
        detectAndReportTemmeGrammarError(event.document)
      }
    }),
    window.onDidChangeActiveTextEditor(event => {
      emitter.emit('did-change-active-text-editor', event)
    }),
    diagnosticCollection,
    statusBarController,
    {
      dispose() {
        stopWatch()
      },
    },
  )

  if (window.activeTextEditor && window.activeTextEditor.document.languageId === 'temme') {
    detectAndReportTemmeGrammarError(window.activeTextEditor.document)
  }
}
