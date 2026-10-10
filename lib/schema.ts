import {
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";

export const TableName = {
  SERVICES: "services",
  BOT_USERS: "bot_users",
  UPSCALE_BINDINGS: "bot_upscale_bindings",
  BOT_STATES: "bot_states",
  TRADER_STATS: "bot_trader_stats",
  SUBSCRIPTIONS: "bot_subscriptions",
  TRADER_POSITIONS: "bot_trader_positions",
  COPY_POSITIONS: "bot_copy_positions",
  DRAWDOWN_SETTINGS: "bot_drawdown_settings",
  DRAWDOWN_STATES: "bot_drawdown_states",
  TRADES: "bot_trades",
} as const;

export type TableName = (typeof TableName)[keyof typeof TableName];

export interface TableSchema {
  name: TableName;
  keySchema: KeySchemaElement[];
  attributeDefinitions: AttributeDefinition[];
  globalSecondaryIndexes?: GlobalSecondaryIndex[];
}

export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {
  [TableName.SERVICES]: {
    name: TableName.SERVICES,
    keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "status", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "status-index",
        KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.BOT_USERS]: {
    name: TableName.BOT_USERS,
    keySchema: [{ AttributeName: "telegramId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "telegramId", AttributeType: "S" }],
  },
  [TableName.UPSCALE_BINDINGS]: {
    name: TableName.UPSCALE_BINDINGS,
    keySchema: [
      { AttributeName: "telegramId", KeyType: "HASH" },
      { AttributeName: "bindingId", KeyType: "RANGE" },
    ],
    attributeDefinitions: [
      { AttributeName: "telegramId", AttributeType: "S" },
      { AttributeName: "bindingId", AttributeType: "S" },
    ],
  },
  [TableName.BOT_STATES]: {
    name: TableName.BOT_STATES,
    keySchema: [{ AttributeName: "telegramId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "telegramId", AttributeType: "S" }],
  },
  [TableName.TRADER_STATS]: {
    name: TableName.TRADER_STATS,
    keySchema: [{ AttributeName: "traderTelegramId", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "traderTelegramId", AttributeType: "S" },
    ],
  },
  [TableName.SUBSCRIPTIONS]: {
    name: TableName.SUBSCRIPTIONS,
    keySchema: [
      { AttributeName: "subscriberTelegramId", KeyType: "HASH" },
      { AttributeName: "traderTelegramId", KeyType: "RANGE" },
    ],
    attributeDefinitions: [
      { AttributeName: "subscriberTelegramId", AttributeType: "S" },
      { AttributeName: "traderTelegramId", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "trader-index",
        KeySchema: [{ AttributeName: "traderTelegramId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.TRADER_POSITIONS]: {
    name: TableName.TRADER_POSITIONS,
    keySchema: [
      { AttributeName: "traderTelegramId", KeyType: "HASH" },
      { AttributeName: "positionId", KeyType: "RANGE" },
    ],
    attributeDefinitions: [
      { AttributeName: "traderTelegramId", AttributeType: "S" },
      { AttributeName: "positionId", AttributeType: "S" },
    ],
  },
  [TableName.COPY_POSITIONS]: {
    name: TableName.COPY_POSITIONS,
    keySchema: [{ AttributeName: "copyId", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "copyId", AttributeType: "S" },
      { AttributeName: "traderTelegramId", AttributeType: "S" },
      { AttributeName: "traderPositionId", AttributeType: "S" },
      { AttributeName: "subscriberTelegramId", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "trader-position-index",
        KeySchema: [
          { AttributeName: "traderTelegramId", KeyType: "HASH" },
          { AttributeName: "traderPositionId", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "subscriber-index",
        KeySchema: [{ AttributeName: "subscriberTelegramId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  [TableName.DRAWDOWN_SETTINGS]: {
    name: TableName.DRAWDOWN_SETTINGS,
    keySchema: [{ AttributeName: "telegramId", KeyType: "HASH" }],
    attributeDefinitions: [{ AttributeName: "telegramId", AttributeType: "S" }],
  },
  [TableName.DRAWDOWN_STATES]: {
    name: TableName.DRAWDOWN_STATES,
    keySchema: [
      { AttributeName: "telegramId", KeyType: "HASH" },
      { AttributeName: "accountId", KeyType: "RANGE" },
    ],
    attributeDefinitions: [
      { AttributeName: "telegramId", AttributeType: "S" },
      { AttributeName: "accountId", AttributeType: "S" },
    ],
  },
  [TableName.TRADES]: {
    name: TableName.TRADES,
    keySchema: [{ AttributeName: "tradeId", KeyType: "HASH" }],
    attributeDefinitions: [
      { AttributeName: "tradeId", AttributeType: "S" },
      { AttributeName: "subscriberTelegramId", AttributeType: "S" },
      { AttributeName: "closedAt", AttributeType: "S" },
      { AttributeName: "traderTelegramId", AttributeType: "S" },
    ],
    globalSecondaryIndexes: [
      {
        IndexName: "subscriber-index",
        KeySchema: [
          { AttributeName: "subscriberTelegramId", KeyType: "HASH" },
          { AttributeName: "closedAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "trader-index",
        KeySchema: [
          { AttributeName: "traderTelegramId", KeyType: "HASH" },
          { AttributeName: "closedAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
};

export const TABLE_NAMES: TableName[] = Object.values(TableName);

export const IndexName = {
  SERVICES_STATUS: "status-index",
  SUBSCRIPTIONS_TRADER: "trader-index",
  COPY_POSITIONS_TRADER_POSITION: "trader-position-index",
  COPY_POSITIONS_SUBSCRIBER: "subscriber-index",
  TRADES_SUBSCRIBER: "subscriber-index",
  TRADES_TRADER: "trader-index",
} as const;

export type IndexName = (typeof IndexName)[keyof typeof IndexName];
