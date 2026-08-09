import type { ClientMessage } from '../shared/browser-protocol.js';

type ClientMessageType = ClientMessage['type'];
type ClientMessageOfType<Type extends ClientMessageType> = Extract<
  ClientMessage,
  { type: Type }
>;

interface ClientMessageRegistration<Context, Type extends ClientMessageType> {
  type: Type;
  dispatch(context: Context, message: ClientMessage): void;
}

type ClientMessageDispatchTable<Context> = {
  [Type in ClientMessageType]: ClientMessageRegistration<Context, Type>;
};

function clientMessageHasType<Type extends ClientMessageType>(
  message: ClientMessage,
  type: Type,
): message is ClientMessageOfType<Type> {
  return message.type === type;
}

function createClientMessageRegistration<Context>() {
  return function register<Type extends ClientMessageType>(
    type: Type,
    handler: (context: Context, message: ClientMessageOfType<NoInfer<Type>>) => void,
  ): ClientMessageRegistration<Context, Type> {
    return {
      type,
      dispatch(context, message) {
        if (!clientMessageHasType(message, type)) {
          throw new Error(`Client message registration mismatch: expected ${type}, received ${message.type}`);
        }
        handler(context, message);
      },
    };
  };
}

function defineClientMessageDispatchTable<Context>(
  table: ClientMessageDispatchTable<Context>,
): ClientMessageDispatchTable<Context> {
  return table;
}

function dispatchClientMessage<Context>(
  table: ClientMessageDispatchTable<Context>,
  context: Context,
  message: ClientMessage,
): void {
  table[message.type].dispatch(context, message);
}

export {
  createClientMessageRegistration,
  defineClientMessageDispatchTable,
  dispatchClientMessage,
  type ClientMessageDispatchTable,
  type ClientMessageOfType,
  type ClientMessageRegistration,
};
