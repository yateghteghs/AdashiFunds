'use strict';
// All amounts are integer kobo (1 NGN = 100 kobo) to avoid floating point errors.
const toKobo = (naira) => Math.round(Number(naira) * 100);
const fromKobo = (kobo) => kobo / 100;
const bps = (amount, basisPoints) => Math.floor((amount * basisPoints) / 10_000);
const format = (kobo, currency = 'NGN') =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(kobo / 100);

module.exports = { toKobo, fromKobo, bps, format };
