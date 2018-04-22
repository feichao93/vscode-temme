import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'
import { Range, TextDocument, Uri, ViewColumn, window, workspace, WorkspaceEdit } from 'vscode'

/** 从链接中下载 HTML */
export async function downloadHtmlFromLink(url: string) {
  let isFileLink = false
  // TODO 处理不同类型的链接
  // http/https 链接: https://zhihu.com/xxx/yy
  // files 链接   file:///D:\workspace\temme\....
  // 相对路径链接  a.html
  // 相对路径链接  ../parent-dir/sub-dir/foo.html

  if (url.startsWith('file:///')) {
    url = url.replace('file:///', '')
    isFileLink = true
  }

  if (isFileLink) {
    return fs.readFileSync(url, 'utf8')
  } else {
    const response = await fetch(url, { timeout: 30000 })
    if (response.ok) {
      return await response.text()
    } else {
      throw new Error(`Cannot download html from ${url}`)
    }
  }
}

export async function placeViewColumnTwoIfNotVisible(doc: TextDocument) {
  const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
  if (!visibleDocs.has(doc)) {
    await window.showTextDocument(doc, ViewColumn.Two)
  }
}

export async function openOutputDocument(temmeDoc: TextDocument) {
  const outputFileName = path.resolve(temmeDoc.uri.fsPath, '../', `${temmeDoc.fileName}.json`)
  const exists = fs.existsSync(outputFileName)
  const fileUri = Uri.file(outputFileName).with({
    scheme: exists ? 'file' : 'untitled',
  })
  return await workspace.openTextDocument(fileUri)
}

export async function replaceWholeDocument(document: TextDocument, content: string) {
  const range = new Range(0, 0, document.lineCount, 0)
  const edit = new WorkspaceEdit()
  edit.replace(document.uri, range, content)
  await workspace.applyEdit(edit)
}

export function pprint(object: any) {
  return JSON.stringify(object, null, 2)
}

export function isTemmeDocActive() {
  return window.activeTextEditor && window.activeTextEditor.document.languageId === 'temme'
}

export function now() {
  const d = new Date()
  const YYYY = String(d.getFullYear()).padStart(4, '0')
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const DD = String(d.getDate()).padStart(2, '0')
  const HH = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const SSS = String(d.getMilliseconds()).padStart(3, '0')
  return `[${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}]`
}
