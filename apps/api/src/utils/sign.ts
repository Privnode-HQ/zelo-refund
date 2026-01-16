import crypto from 'node:crypto';

export const createSignString = (params: Record<string, unknown>) => {
  const entries = Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
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
