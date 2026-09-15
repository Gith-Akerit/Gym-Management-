// The files a browser hands to this system, small enough to keep in a file.
//
// Separate from the fixtures that open a database, so the browser suite can
// import them without pulling a server into a Playwright process.

/** A one-pixel PNG that real image decoders will actually open. */
export const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

/**
 * A real photograph: 48x48, from a real JPEG encoder, decodes anywhere.
 *
 * Member photographs are opened on the way in now, so a hand-assembled stub is
 * no longer a photograph as far as the counter is concerned (QA PHOTO-03).
 */
export const PHOTO_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi'
  + 'MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7'
  + 'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwADADASIAAhEBAxEB/8QAGAABAQADAAAAAAAAAAAAAAAAAAIFBgf/'
  + 'xAAjEAACAgAFBAMAAAAAAAAAAAABAgADBAUGESESEzFhMnGh/8QAGQEAAgMBAAAAAAAAAAAAAAAAAAQBAgMF/8QAGxEB'
  + 'AQEAAgMAAAAAAAAAAAAAAAERAhITITH/2gAMAwEAAhEDEQA/ANtiJLutaM7sFVQSzE8ATlukqJz/ADbXuLsxDJlirTSv'
  + 'Asdepm97HgRlOvcXXiFTM1W6luDYi9LL72HBmnj5Zqnea6BElHWxFdGDKwBUg8ESpmuTE6pNg01ju18u3z9bjf8AN5lp'
  + 'NiJbW1dihkYEMpHBEmXKL8cTibfmugsXXez5Y6W0nkVu3Sy+t/BjKtBYuy9XzN0qpHJrRupm9b+BGe/HNL9K2nSxsOms'
  + 'D3fl2+Prc7fm0y0mtEqrWutQqKAFUDYASotbtMT1CIiQCIiAIiIB/9k=', 'base64');

/**
 * Something a browser will hand over that begins like a JPEG and is not one.
 *
 * Exactly the shape of the bug QA found: perfect magic bytes and nothing
 * behind them a decoder can open -- an upload cut off halfway. Slips are never
 * decoded, so this is still a valid slip as far as that queue is concerned.
 */
export function jpegBuffer() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}
