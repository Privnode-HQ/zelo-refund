import crypto from 'node:crypto';

export const createSignString = (params: Record<string, unknown>) => {
  const entries = Object.entries(params)
    .filter(([key, value]) => {
      if (key === 'sign' || key === 'sign_type' || key === 'signType') return false;
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value)) return false;
      if (typeof value === 'object') {
        if (value instanceof ArrayBuffer) return false;
        if (ArrayBuffer.isView(value)) return false;
        if (Buffer.isBuffer(value)) return false;
        return false;
      }
      return true;
    })
    // ASCII (byte) order for common parameter keys
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${String(v)}`).join('&');
};

export const rsaSignBase64 = (message: string, privateKeyPem: string, algorithm: 'RSA-SHA256' | 'RSA-SHA1') => {
  const signer = crypto.createSign(algorithm);
  signer.update(message);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
};

export const rsaVerifyBase64 = (
  message: string,
  signatureBase64: string,
  publicKeyPem: string,
  algorithm: 'RSA-SHA256' | 'RSA-SHA1'
) => {
  const verifier = crypto.createVerify(algorithm);
  verifier.update(message);
  verifier.end();
  return verifier.verify(publicKeyPem, signatureBase64, 'base64');
};
