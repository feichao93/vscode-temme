import { CancellationToken, DocumentSymbolProvider, SymbolInformation, TextDocument } from 'vscode'

export default class TemmeDocumentSymbolProvider implements DocumentSymbolProvider {
  public async provideDocumentSymbols(
    document: TextDocument,
    token: CancellationToken,
  ): Promise<SymbolInformation[]> {
    // TODO TemmeDocumentSymbolProvider
    return []
  }
}
