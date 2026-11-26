ObjC.import('Foundation');
ObjC.import('PDFKit');

function run(args) {
  const url = $.NSURL.fileURLWithPath(args[0]);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (!document || document.isLocked || document.pageCount < 1) {
    throw new Error('Cannot read PDF');
  }
  const pages = [];
  for (let index = 0; index < document.pageCount; index += 1) {
    pages.push(ObjC.unwrap(document.pageAtIndex(index).string) || '');
  }
  return JSON.stringify(pages);
}
