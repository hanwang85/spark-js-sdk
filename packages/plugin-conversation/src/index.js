/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 * @private
 */

import '@ciscospark/plugin-encryption';
import '@ciscospark/plugin-user';

import {patterns} from '@ciscospark/common';
import {filter as htmlFilter} from '@ciscospark/helper-html';
import {registerPlugin} from '@ciscospark/spark-core';
import Conversation from './conversation';
import config from './config';
import {has} from 'lodash';
import S from 'string';

import {transforms as encryptionTransforms} from './encryption-transforms';
import {transforms as decryptionTransforms} from './decryption-transforms';

registerPlugin(`conversation`, Conversation, {
  payloadTransformer: {
    predicates: [
      {
        name: `transformObject`,
        test(ctx, optionsOrResponse) {
          return Promise.resolve(has(optionsOrResponse, `body.objectType`));
        },
        extract(optionsOrResponse) {
          return Promise.resolve(optionsOrResponse.body);
        }
      },
      {
        name: `transformObject`,
        direction: `inbound`,
        test(ctx, event) {
          return Promise.resolve(has(event, `activity`));
        },
        extract(event) {
          return Promise.resolve(event.activity);
        }
      },
      {
        name: `transformObjectArray`,
        direction: `inbound`,
        test(ctx, options) {
          return Promise.resolve(has(options, `body.items[0].objectType`));
        },
        extract(options) {
          return Promise.resolve(options.body.items);
        }
      }
    ],
    transforms: [
      {
        name: `transformObjectArray`,
        fn(ctx, array) {
          return Promise.all(array.map((item) => ctx.transform(`transformObject`, item)));
        }
      },
      {
        name: `transformObject`,
        direction: `outbound`,
        fn(ctx, object) {
          if (!object) {
            return Promise.resolve();
          }

          if (!object.objectType) {
            return Promise.resolve();
          }

          return ctx.transform(`normalizeObject`, object)
            .then(() => ctx.transform(`encryptObject`, object))
            .then(() => ctx.transform(`encryptKmsMessage`, object));
        }
      },
      {
        name: `transformObject`,
        direction: `inbound`,
        fn(ctx, object) {
          if (!object) {
            return Promise.resolve();
          }

          if (!object.objectType) {
            return Promise.resolve();
          }

          return ctx.transform(`normalizeObject`, object)
            .then(() => ctx.transform(`decryptObject`, object));
        }
      },
      {
        name: `normalizeObject`,
        fn(ctx, object) {
          if (!object) {
            return Promise.resolve();
          }

          if (!object.objectType) {
            return Promise.resolve();
          }

          return Promise.all([
            ctx.transform(`normalize${S(object.objectType).capitalize().s}`, object),
            ctx.transform(`normalizePropContent`, object)
          ]);
        }
      },
      {
        name: `normalizePropContent`,
        direction: `inbound`,
        fn(ctx, object) {
          if (!object.content) {
            return Promise.resolve();
          }
          const {
            inboundProcessFunc,
            allowedInboundTags,
            allowedInboundStyles
          } = ctx.spark.config.conversation;

          return htmlFilter(inboundProcessFunc, allowedInboundTags || {}, allowedInboundStyles, object.content)
            .then((c) => {
              object.content = c;
            });
        }
      },
      {
        name: `normalizePropContent`,
        direction: `outbound`,
        fn(ctx, object) {
          if (!object.content) {
            return Promise.resolve();
          }

          const {
            outboundProcessFunc,
            allowedOutboundTags,
            allowedOutboundStyles
          } = ctx.spark.config.conversation;

          return htmlFilter(outboundProcessFunc, allowedOutboundTags || {}, allowedOutboundStyles, object.content)
            .then((c) => {
              object.content = c;
            });
        }
      },
      {
        name: `normalizeConversation`,
        fn(ctx, conversation) {
          conversation.activities = conversation.activities || {};
          conversation.activities.items = conversation.activities.items || [];
          conversation.participants = conversation.participants || {};
          conversation.participants.items = conversation.participants.items || [];

          return Promise.all([
            Promise.all(conversation.activities.items.map((item) => ctx.transform(`normalizeObject`, item))),
            Promise.all(conversation.participants.items.map((item) => ctx.transform(`normalizeObject`, item)))
          ]);
        }
      },
      {
        name: `normalizeActivity`,
        fn(ctx, activity) {
          return Promise.all([
            ctx.transform(`normalizeObject`, activity.actor),
            ctx.transform(`normalizeObject`, activity.object),
            ctx.transform(`normalizeObject`, activity.target)
          ]);
        }
      },
      {
        name: `normalizePerson`,
        // eslint-disable-next-line complexity
        fn(ctx, person) {
          const email = person.entryEmail || person.emailAddress || person.id;
          const id = person.entryUUID || person.id;

          if (patterns.email.test(email)) {
            person.entryEmail = person.emailAddress = email.toLowerCase();
          }
          else {
            Reflect.deleteProperty(person, `entryEmail`);
            Reflect.deleteProperty(person, `emailAddress`);
          }

          if (person.roomProperties) {
            person.roomProperties.isModerator = Boolean(person.roomProperties.isModerator);
          }

          if (patterns.uuid.test(id)) {
            person.entryUUID = person.id = id.toLowerCase();
            return Promise.resolve(person);
          }

          if (!email) {
            return Promise.reject(new Error(`cannot determine id without an \`emailAddress\` or \`entryUUID\` property`));
          }

          return ctx.spark.user.asUUID(email)
            .then((uuid) => {
              person.entryUUID = person.id = uuid;
              return person;
            });
        }
      }
    ]
    .concat(decryptionTransforms)
    .concat(encryptionTransforms)
  },
  config
});

export {default as default} from './conversation';
export {default as ShareActivity} from './share-activity';
