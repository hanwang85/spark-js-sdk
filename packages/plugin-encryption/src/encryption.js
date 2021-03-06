/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 * @private
 */

import {SparkPlugin} from '@ciscospark/spark-core';
import {proxyEvents, tap, transferEvents} from '@ciscospark/common';
import {EventEmitter} from 'events';
import jose from 'node-jose';
import SCR from 'node-scr';
import ensureBuffer from './ensure-buffer';

import KMS from './kms';

const Encryption = SparkPlugin.extend({
  children: {
    kms: KMS
  },

  namespace: `Encryption`,

  processKmsMessageEvent(event) {
    return this.kms.processKmsMessageEvent(event);
  },

  decryptBinary(scr, buffer) {
    return ensureBuffer(buffer)
      .then((b) => {
        /* istanbul ignore if */
        if (buffer.length === 0 || buffer.byteLength === 0) {
          return Promise.reject(new Error(`Attempted to decrypt zero-length buffer`));
        }

        return scr.decrypt(b);
      })
      .then(ensureBuffer);
  },

  decryptScr(key, cipherScr) {
    return this.getKey(key)
      .then((k) => SCR.fromJWE(k.jwk, cipherScr));
  },

  decryptText(key, ciphertext) {
    return this.getKey(key)
      .then((k) => jose.JWE
        .createDecrypt(k.jwk)
        .decrypt(ciphertext)
        .then((result) => result.plaintext.toString()));
  },

  download(scr) {
    /* istanbul ignore if */
    if (!scr.loc) {
      return Promise.reject(new Error(`\`scr.loc\` is required`));
    }

    const shunt = new EventEmitter();
    const promise = this._fetchDownloadUrl(scr)
      .then((uri) => {
        const options = {
          method: `GET`,
          uri,
          responseType: `buffer`
        };

        const ret = this.request(options);
        transferEvents(`progress`, options.download, shunt);

        return ret;
      })
      .then((res) => this.decryptBinary(scr, res.body));

    proxyEvents(shunt, promise);
    return promise;
  },

  _fetchDownloadUrl(scr) {
    this.logger.info(`encryption: retrieving download url for encrypted file`);

    if (process.env.NODE_ENV !== `production` && scr.loc.includes(`localhost`)) {
      this.logger.info(`encryption: bypassing spark files because this looks to be a test file on localhost`);
      return Promise.resolve(scr.loc);
    }

    return this.request({
      method: `POST`,
      service: `files`,
      resource: `download/endpoints`,
      body: {
        endpoints: [
          scr.loc
        ]
      }
    })
      .then((res) => {
        const url = res.body.endpoints[scr.loc];
        if (!url) {
          this.logger.warn(`encryption: could not determine download url for \`scr.loc\`; attempting to download \`scr.loc\` directly`);
          return scr.loc;
        }
        this.logger.info(`encryption: retrieved download url for encrypted file`);
        return url;
      });
  },

  encryptBinary(file) {
    return ensureBuffer(file)
      .then((buffer) => SCR.create()
        .then((scr) => scr.encrypt(buffer)
          .then(ensureBuffer)
          // eslint-disable-next-line max-nested-callbacks
          .then((cdata) => ({scr, cdata}))));
  },

  encryptScr(key, scr) {
    /* istanbul ignore if */
    if (!scr.loc) {
      return Promise.reject(`Cannot encrypt \`scr\` without first setting \`loc\``);
    }
    return this.getKey(key)
      .then((k) => scr.toJWE(k.jwk));
  },

  encryptText(key, plaintext) {
    return this.getKey(key)
      .then((k) => jose.JWE
        .createEncrypt(this.config.joseOptions, {
          key: k.jwk,
          header: {
            alg: `dir`
          },
          reference: null
        })
        .final(plaintext, `utf8`));
  },

  getKey(uri) {
    if (uri.jwk) {
      return this.kms.asKey(uri);
    }

    return this.unboundedStorage.get(uri)
      .then((keyString) => JSON.parse(keyString))
      .then((keyObject) => this.kms.asKey(keyObject))
      .catch(() => this.kms.fetchKey({uri})
        .then(tap((key) => this.unboundedStorage.put(key.uri, JSON.stringify(key, replacer)))));
  }
});

/**
 * JSON.stringify replacer that ensures private key data is serialized.
 * @param {string} k
 * @param {mixed} v
 * @returns {mixed}
 */
function replacer(k, v) {
  if (k === `jwk`) {
    // note: this[k] and v may be different representations of the same value
    // eslint-disable-next-line no-invalid-this
    const json = this[k].toJSON(true);
    return json;
  }
  return v;
}

export default Encryption;
