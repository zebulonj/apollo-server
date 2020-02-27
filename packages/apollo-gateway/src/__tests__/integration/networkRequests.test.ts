import nock from 'nock';
import { fetch } from 'apollo-server-env';
import { ApolloGateway, GCS_RETRY_COUNT, getDefaultGcsFetcher } from '../..';
import {
  mockLocalhostSDLQuery,
  mockStorageSecretSuccess,
  mockStorageSecret,
  mockCompositionConfigLinkSuccess,
  mockCompositionConfigLink,
  mockCompositionConfigsSuccess,
  mockCompositionConfigs,
  mockImplementingServicesSuccess,
  mockImplementingServices,
  mockRawPartialSchemaSuccess,
  mockRawPartialSchema,
  apiKeyHash,
  graphId,
} from './nockMocks';

// This is a nice DX hack for GraphQL code highlighting and formatting within the file.
// Anything wrapped within the gql tag within this file is just a string, not an AST.
const gql = String.raw;

let fetcher: typeof fetch;

const service = {
  implementingServicePath: 'service-definition.json',
  partialSchemaPath: 'accounts-partial-schema.json',
  federatedServiceURL: 'http://localhost:4001',
  federatedServiceSchema: gql`
    extend type Query {
      me: User
      everyone: [User]
    }

    "This is my User"
    type User @key(fields: "id") {
      id: ID!
      name: String
      username: String
    }
  `,
};

const updatedService = {
  implementingServicePath: 'updated-service-definition.json',
  partialSchemaPath: 'updated-accounts-partial-schema.json',
  federatedServiceURL: 'http://localhost:4002',
  federatedServiceSchema: gql`
    extend type Query {
      me: User
      everyone: [User]
    }

    "This is my updated User"
    type User @key(fields: "id") {
      id: ID!
      name: String
      username: String
    }
  `,
};

beforeEach(() => {
  if (!nock.isActive()) nock.activate();

  fetcher = getDefaultGcsFetcher().defaults({
    retry: {
      retries: GCS_RETRY_COUNT,
      minTimeout: 10,
      maxTimeout: 100,
    }
  });
});

afterEach(() => {
  expect(nock.isDone()).toBeTruthy();
  nock.cleanAll();
  nock.restore();
  jest.useRealTimers();
});

it('Queries remote endpoints for their SDLs', async () => {
  mockLocalhostSDLQuery({ url: service.federatedServiceURL }).reply(200, {
    data: { _service: { sdl: service.federatedServiceSchema } },
  });

  const gateway = new ApolloGateway({
    serviceList: [
      { name: 'accounts', url: `${service.federatedServiceURL}/graphql` },
    ],
  });
  await gateway.load();
  expect(gateway.schema!.getType('User')!.description).toBe('This is my User');
});

// This test is maybe a bit terrible, but IDK a better way to mock all the requests
it('Extracts service definitions from remote storage', async () => {
  mockStorageSecretSuccess();
  mockCompositionConfigLinkSuccess();
  mockCompositionConfigsSuccess([service.implementingServicePath]);
  mockImplementingServicesSuccess(service);
  mockRawPartialSchemaSuccess(service);

  const gateway = new ApolloGateway({});

  await gateway.load({ engine: { apiKeyHash, graphId } });
  expect(gateway.schema!.getType('User')!.description).toBe('This is my User');
});

it('Rollsback to a previous schema when triggered', async () => {
  // Init
  mockStorageSecretSuccess();
  mockCompositionConfigLinkSuccess();
  mockCompositionConfigsSuccess([service.implementingServicePath]);
  mockImplementingServicesSuccess(service);
  mockRawPartialSchemaSuccess(service);

  // Update 1
  mockStorageSecretSuccess();
  mockCompositionConfigLinkSuccess();
  mockCompositionConfigsSuccess([updatedService.implementingServicePath]);
  mockImplementingServicesSuccess(updatedService);
  mockRawPartialSchemaSuccess(updatedService);

  // Rollback
  mockStorageSecretSuccess();
  mockCompositionConfigLinkSuccess();
  mockCompositionConfigsSuccess([service.implementingServicePath]);
  mockImplementingServices(service).reply(304);
  mockRawPartialSchema(service).reply(304);

  jest.useFakeTimers();

  const onChange = jest.fn();
  const gateway = new ApolloGateway();
  await gateway.load({ engine: { apiKeyHash, graphId } });
  gateway.onSchemaChange(onChange);

  // 10000 ms is the default pollInterval
  jest.advanceTimersByTime(10000);

  // This useReal/useFake is challenging to explain the need for, and I probably
  // don't have the _correct_ answer here, but it seems that pushing this process
  // to the back of the task queue is insufficient.
  jest.useRealTimers();
  await new Promise(resolve => setTimeout(resolve, 100));
  jest.useFakeTimers();

  expect(onChange.mock.calls.length).toBe(1);

  jest.advanceTimersByTime(10000);

  jest.useRealTimers();
  await new Promise(resolve => setTimeout(resolve, 100));
  jest.useFakeTimers();

  expect(onChange.mock.calls.length).toBe(2);
});

function failNTimes(n: number, fn: () => nock.Interceptor) {
  for (let i = 0; i < n; i++) {
    fn().reply(500);
  }
}

it(`Retries GCS (up to ${GCS_RETRY_COUNT} times) on failure for each request and succeeds`, async () => {
  failNTimes(GCS_RETRY_COUNT, mockStorageSecret);
  mockStorageSecretSuccess();

  failNTimes(GCS_RETRY_COUNT, mockCompositionConfigLink);
  mockCompositionConfigLinkSuccess();

  failNTimes(GCS_RETRY_COUNT, mockCompositionConfigs);
  mockCompositionConfigsSuccess([service.implementingServicePath]);

  failNTimes(GCS_RETRY_COUNT, () => mockImplementingServices(service));
  mockImplementingServicesSuccess(service);

  failNTimes(GCS_RETRY_COUNT, () => mockRawPartialSchema(service));
  mockRawPartialSchemaSuccess(service);

  const gateway = new ApolloGateway({ fetcher });

  await gateway.load({ engine: { apiKeyHash, graphId } });
  expect(gateway.schema!.getType('User')!.description).toBe('This is my User');
});

it(`Fails after the ${GCS_RETRY_COUNT + 1}th attempt to reach GCS`, async () => {
  failNTimes(GCS_RETRY_COUNT + 1, mockStorageSecret);

  const gateway = new ApolloGateway({ fetcher });
  await expect(
    gateway.load({ engine: { apiKeyHash, graphId } }),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Could not communicate with Apollo Graph Manager storage: "`,
  );
});

it(`Errors when the secret isn't hosted on GCS`, async () => {
  mockStorageSecret().reply(
    403,
    `<Error><Code>AccessDenied</Code>
    Anonymous caller does not have storage.objects.get`,
    { 'content-type': 'application/xml' },
  );

  const gateway = new ApolloGateway({ fetcher });
  await expect(
    gateway.load({ engine: { apiKeyHash, graphId } }),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Unable to authenticate with Apollo Graph Manager storage while fetching https://storage.googleapis.com/engine-partial-schema-prod/federated-service/storage-secret/dd55a79d467976346d229a7b12b673ce.json"`,
  );
});
