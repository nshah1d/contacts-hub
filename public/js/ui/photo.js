import { LIMITS, invariant } from '../core/primitives.js';
/**
 * Accepts a small embedded PNG or JPEG portrait only. Remote images and other formats stay
 * in the source but are never fetched or rendered. Dimensions are read from the PNG IHDR
 * chunk (https://www.w3.org/TR/png-3/#11IHDR) or the JPEG frame header before any decode,
 * so an oversized image is refused without being rendered.
 * @param {{value: string, params?: object}} entry A PHOTO property.
 * @returns {?{bytes: Uint8Array, mime: string, width: number, height: number}} null when the photo is not embedded.
 * @throws {Error} When the image is malformed or larger than the preview limits.
 */
export function embeddedPhoto(entry) {
    let encoded = entry.value, declared = '';
    const uri = /^data:(image\/(?:png|jpeg));base64,(.*)$/is.exec(encoded);
    if (uri) {
        declared = uri[1].toLowerCase();
        encoded = uri[2];
    }
    else if (!/^(b|base64)$/i.test(entry.params?.ENCODING || ''))
        return null;
    encoded = encoded.replace(/\s/g, '');
    invariant(encoded.length <= Math.ceil(LIMITS.imageBytes / 3) * 4 && /^[a-z0-9+/]*={0,2}$/i.test(encoded) && encoded.length % 4 === 0, 'This embedded photo is outside the preview limit.');
    const binary = atob(encoded), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    let mime, width = 0, height = 0;
    if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
        mime = 'image/png';
        const view = new DataView(bytes.buffer);
        width = view.getUint32(16);
        height = view.getUint32(20);
    }
    else if (bytes[0] === 255 && bytes[1] === 216) {
        mime = 'image/jpeg';
        let at = 2;
        while (at + 8 < bytes.length) {
            if (bytes[at] !== 255)
                break;
            while (bytes[at] === 255)
                at++;
            const marker = bytes[at++];
            if (marker === 0xda || marker === 0xd9)
                break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
                continue;
            const length = (bytes[at] << 8) | bytes[at + 1];
            if (length < 2 || at + length > bytes.length)
                break;
            // Start-of-frame markers; C4, C8 and CC share the range but carry no frame size.
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                height = (bytes[at + 3] << 8) | bytes[at + 4];
                width = (bytes[at + 5] << 8) | bytes[at + 6];
                break;
            }
            at += length;
        }
    }
    invariant(mime && (!declared || declared === mime) && width > 0 && height > 0 && width <= LIMITS.imageDimension && height <= LIMITS.imageDimension, 'Only embedded PNG/JPEG portraits up to 2,048 pixels are previewed.');
    return { bytes, mime, width, height };
}
