import { CognitoIdentity, CognitoIdentityServiceProvider, DynamoDB } from 'aws-sdk';
import {
  ListUserPoolsResponse,
  PaginationKeyType, UserPoolDescriptionType
} from 'aws-sdk/clients/cognitoidentityserviceprovider';
import * as fs from 'fs';
import * as jsonfile from 'jsonfile';
import { memoize } from 'lodash';
import * as meow from 'meow';
import * as moniker from 'moniker';

const cli = meow(`
    Usage
      $ npm start -- export
      
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
      can be specified in env variables or ~/.aws/credentials
`);

const accessKeyId = process.env.AWS_ACCESS_ID;
const secretAccessKey = process.env.AWS_SECRET_KEY;
const sessionToken = process.env.AWS_SESSION_TOKEN;
const region = "eu-central-1"
const awsConfig = {
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region
};
const dynamo = new DynamoDB(awsConfig);
const cognito = new CognitoIdentityServiceProvider(awsConfig);
const cognitoIdentity = new CognitoIdentity(awsConfig);

const names = moniker.generator([moniker.adjective, moniker.noun]);


export const pagedAWSCall = async <TAPIResult, TData, TNextToken, TParams = {}>(
  action: (params: TParams, nextToken?: TNextToken) => Promise<TAPIResult>,
  params: TParams,
  accessor: (result?: TAPIResult) => TData[],
  getNextToken: (serviceResponse: TAPIResult, result: TData[]) => Promise<TNextToken | undefined>,
): Promise<TData[]> => {


  let result: TData[] = [];
  let response: TAPIResult;
  let nextToken: TNextToken = undefined;
  do {
    response = await action(params, nextToken);

    if (response && accessor(response)) {
      result = result.concat(accessor(response));
    }
    nextToken = response ? await getNextToken(response, result) : undefined;
  } while (!!nextToken);

  return result;
};

// const exportUsers = async (memberTableName: string, tenantTableName: string, domainTableName: string) => {
//   console.log(`Fetching all items from table ${memberTableName}...`);
//   const memberItems = await getAllItems(memberTableName);
//   const distinctPoolIds = uniq(memberItems.map(item => item.authPoolId.S));
//   console.log(`Found ${memberItems.length} items in table ${memberTableName} referencing ${distinctPoolIds.length} unique pools.`);

//   let pools = [];
//   let missingPools = [];
//   for (const poolId of distinctPoolIds) {
//     let poolName = '';
//     try {
//       const { UserPool: pool } = await cognito.describeUserPool({ UserPoolId: poolId }).promise();
//       poolName = pool.Name;
//     } catch (error) {
//       if (error.name === 'ResourceNotFoundException') {
//         missingPools.push(poolId);
//         continue;
//       }
//     }

//     console.log(`Fetching all users from pool ${poolName} (${poolId})...`);
//     try {
//       const poolUsers = await getAllUsers(poolId);
//       console.log(`Found ${poolUsers.length} users in pool ${poolName}.`);
//       pools = [...pools, { poolId, poolName, users: poolUsers.map(scrubPoolUser) }];
//       console.log(`Scrubbed user names and emails for pool ${poolName}`);
//     } catch (error) {
//       console.error(`Error getting users from pool ${poolId}`);
//       console.error(error);
//     }
//   }

//   if (missingPools.length) {
//     console.log(`There are members referencing ${missingPools.length} missing cognito pools.`);
//   }

//   console.log(`Fetching all items in table ${tenantTableName}...`);
//   const tenants = await getAllItems(tenantTableName);
//   console.log(`Found ${tenantTableName.length} tenants in table ${tenantTableName}`);

//   console.log(`Fetching all items in table ${domainTableName}...`);
//   const domains = await getAllItems(domainTableName);
//   console.log(`Found ${domains.length} domains in table ${domainTableName}`);

//   const dataFolder = './data';
//   const dataSubfolder = `${dataFolder}/${stage}_${region}`;
//   if (!fs.existsSync(dataFolder)) {
//     fs.mkdirSync(dataFolder);
//   }
//   if (!fs.existsSync(dataSubfolder)) {
//     fs.mkdirSync(dataSubfolder);
//   }

//   console.log(`Writing data to files at ./data/${dataSubfolder}`);
//   jsonfile.writeFileSync(`${dataSubfolder}/members.json`, memberItems.map(scrubMember), { spaces: 2 });
//   jsonfile.writeFileSync(`${dataSubfolder}/pools.json`, pools, { spaces: 2 });
//   jsonfile.writeFileSync(`${dataSubfolder}/tenants.json`, tenants, { spaces: 2 });
//   jsonfile.writeFileSync(`${dataSubfolder}/domains.json`, domains, { spaces: 2 });
//   jsonfile.writeFileSync(`${dataSubfolder}/missingPools.json`, missingPools, { spaces: 2 });
//   console.log(`Data wrote to ${dataSubfolder}`);
// };

const scrubbedEmailMemo = memoize(email => {
  const domain = email.substring(email.indexOf('@'));
  const name: string = names.choose();
  const first = name.split('-')[0];
  const last = name.split('-')[1];
  const newEmail = `${name.replace('-', '.')}${domain}`;

  return {
    first,
    last,
    email: newEmail
  };
});

const scrubPoolUser = (user) => {
  const oldEmail = (user.Attributes.find(attr => attr.Name === 'email') || { Name: 'email', Value: '' }).Value;
  if (oldEmail.endsWith('cleo.com') || oldEmail.endsWith('mailosaur.io')) {
    return user;
  }

  const { first, last, email: newEmail } = scrubbedEmailMemo(oldEmail);
  const isUserNameAnEmail = user.Username.indexOf('@') >= 0;

  return {
    ...user,
    Username: isUserNameAnEmail ? newEmail : user.Username,
    Attributes: user.Attributes
      .filter(attr => !['given_name', 'family_name', 'preferred_name', 'email'].includes(attr.Name))
      .concat([
        { Name: 'email', Value: newEmail },
        { Name: 'given_name', Value: first },
        { Name: 'family_name', Value: last }
      ])
  };
};

const scrubMember = (member) => {
  const domain = member.email.S.substring(member.email.S.indexOf('@'));
  if (domain.endsWith('cleo.com') || domain.endsWith('mailosaur.io')) {
    return member;
  }

  const { email } = scrubbedEmailMemo(member.email.S);
  return {
    ...member,
    email: { S: email }
  };
};

const getAllItems = async (tableName: string, accumedMembers = [], startKey?): Promise<DynamoDB.AttributeMap[]> => {
  const { Items: items, LastEvaluatedKey: lastKey } =
    await dynamo.scan({ TableName: tableName, ExclusiveStartKey: startKey }).promise();

  if (lastKey) {
    return getAllItems(tableName, [...accumedMembers, ...items], lastKey);
  }

  return [...accumedMembers, ...items];
};

const getAllUsers = async (poolId: string, accumedUsers = [], includeCustomAttrs = true, pageToken?: string) => {
  // const customAttributes = ['given_name', 'family_name', 'custom:company', 'custom:title'];
  const params = {
    // 'AttributesToGet': ['email'].concat(includeCustomAttrs ? customAttributes : []),
    'UserPoolId': poolId
  };

  try {
    // await new Promise(res => setTimeout(res, 500));
    const { Users: cognitoUsers, PaginationToken: nextPageToken } = await cognito.listUsers({ ...params, PaginationToken: pageToken }).promise();
    if (nextPageToken) {
      return getAllUsers(poolId, [...accumedUsers, ...cognitoUsers], includeCustomAttrs, nextPageToken);
    }

    return [...accumedUsers, ...cognitoUsers];
  } catch (error) {
    if (includeCustomAttrs &&
      error.name === 'InvalidParameterException' &&
      error.message.indexOf('One or more requested attributes do not exist') >= 0) {
      return getAllUsers(poolId, accumedUsers, false, pageToken);
    }

    throw error;
  }
};

let cachedUserPoolIds = []
let cachedIdentityPoolIds = []


const listIdentityPools = async () => {
  if (cachedIdentityPoolIds.length === 0) {
    const result = await pagedAWSCall<CognitoIdentity.Types.ListIdentityPoolsResponse, any, any>(
      async (params: CognitoIdentity.Types.ListIdentityPoolsInput, nextToken: PaginationKeyType) => {
        // console.log('listUserPool.cognito.listUserPools', [{ params, NextToken: nextToken }]);
        return await cognitoIdentity.listIdentityPools({
          ...params,
          NextToken: nextToken,
        })
          .promise();
      },
      {
        MaxResults: 60
      },
      (response) => response.IdentityPools,
      async (response) => {
        return response.NextToken;
        // return ''
      }
    );

    cachedIdentityPoolIds.push(...result);
  }

  return cachedIdentityPoolIds;
}


export const describeIdentityPool = (
  cognitoIdentity: CognitoIdentity,
  IdentityPoolId: string
) => cognitoIdentity.describeIdentityPool({ IdentityPoolId }).promise();

const listUserPools = async () => {
  if (cachedUserPoolIds.length === 0) {
    const result = await pagedAWSCall<ListUserPoolsResponse, UserPoolDescriptionType, PaginationKeyType>(
      async (params: CognitoIdentityServiceProvider.Types.ListUserPoolsRequest, nextToken: PaginationKeyType) => {
        // console.log('listUserPool.cognito.listUserPools', [{ params, NextToken: nextToken }]);
        return await cognito
          .listUserPools({
            ...params,
            NextToken: nextToken,
          })
          .promise();
      },
      {
        MaxResults: 60
      },
      (response) => response.UserPools,
      async (response) => {
        return response.NextToken;
        // return ''
      }
    );

    cachedUserPoolIds.push(...result);
  }

  return cachedUserPoolIds;
}

const main = async () => {
  // List user pools
  const pools = await listUserPools() || []
  // const pools: any[] = [{Id: 'eu-central-1_imAhCdB3e', Name: 'organization-dev-909674-Aqihs0LW-MQLr9NW4oBT-'}]

  for (const pool of pools) {
    let poolId = pool.Id
    let poolName = pool.Name

    try {
      const poolUsers = await getAllUsers(poolId);
      let isAllUserForceChangePassword = poolUsers.length > 0 && poolUsers?.every((poolUser => poolUser?.UserStatus === 'FORCE_CHANGE_PASSWORD'))
      let isEmptyUsers = poolUsers?.length === 0
      if (isEmptyUsers) {
        pool.isPrepareToDelete = true
        pool.reasonDelete = 'Is empty users'
        pool.poolUsers = poolUsers;
      }

      if (isAllUserForceChangePassword) {
        pool.isPrepareToDelete = true
        pool.poolUsers = poolUsers;
        pool.reasonDelete = 'Is all users force change password'
      }

      console.log(`Found ${poolUsers.length} users in pool ${poolId} ${poolName}`,);
    } catch (error) {
      console.error(`Error getting users from pool ${poolId} ${poolName}`);
      console.error(error);
    }
  }

  const dataFolder = './data';
  const dataSubfolder = `${dataFolder}/${region}`;
  if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder);
  }
  if (!fs.existsSync(dataSubfolder)) {
    fs.mkdirSync(dataSubfolder);
  }

  console.log(pools.length)

  // jsonfile.writeFileSync(`${dataSubfolder}/all-pools.json`, pools, { spaces: 2 });

  const deletePools = pools.filter(pool => pool?.isPrepareToDelete)
  console.log('deletePools = ' + deletePools.length)
  jsonfile.writeFileSync(`${dataSubfolder}/delete-pools.json`, deletePools, { spaces: 2 });


  let realPools = pools.filter(pool => !pool?.isPrepareToDelete);
  console.log('keepPools = ' + realPools?.length)
  jsonfile.writeFileSync(`${dataSubfolder}/keep-pools.json`, realPools, { spaces: 2 });

  const identityPools = await listIdentityPools() || []
  console.log(identityPools[0])

  const findUserPoolByProviderName = (providerName: string) => {
    let userPoolMatchs = realPools?.filter((pool) => providerName?.endsWith('/' + pool.Id))
    if (providerName?.startsWith("cognito-idp") && userPoolMatchs?.length > 0) {
      return userPoolMatchs
    }
    return []
  }

  for (const identityPool of identityPools) {
    let response = await describeIdentityPool(cognitoIdentity, identityPool?.IdentityPoolId);

    if (response?.CognitoIdentityProviders?.length === 0) {
      identityPool.isPrepareToDelete = true
      identityPool.reasonDelete = 'CognitoIdentityProviders empty'
    } else if (response?.CognitoIdentityProviders.length === 1) {
      let providerName = response.CognitoIdentityProviders?.[0]?.ProviderName
      let userPoolMatchs = findUserPoolByProviderName(providerName)
      if (userPoolMatchs?.length === 0) {
        identityPool.isPrepareToDelete = true;
        identityPool.reasonDelete = `ProviderName ${providerName} not match any user pool`;
      }
    } else {
      console.debug("CognitoIdentityProviders > 1" + JSON.stringify(response))
    }
  }

  console.log("totalIdentityPools = " + identityPools.length)

  const deleteIdentityPools = identityPools.filter(pool => pool?.isPrepareToDelete);
  jsonfile.writeFileSync(`${dataSubfolder}/delete-identity-pools.json`, deleteIdentityPools, { spaces: 2 });
  console.log('deleteIdentityPools = ' + deleteIdentityPools?.length)

  const keepIdentityPools = identityPools.filter(pool => !pool?.isPrepareToDelete);
  jsonfile.writeFileSync(`${dataSubfolder}/keep-identity-pools.json`, keepIdentityPools, { spaces: 2 });
  console.log('keepIdentityPools = ' + keepIdentityPools?.length)


  for (const deletePool of deletePools) {

    await cognito.deleteUserPool({
      UserPoolId: deletePool.Id
    }).promise()
    console.log(`deleteUserPool ${deletePool.Id}`)
  }

  for (const deleteIdentityPool of deleteIdentityPools) {
    await cognitoIdentity.deleteIdentityPool({
      IdentityPoolId: deleteIdentityPool.IdentityPoolId
    }).promise()
    console.log(`deleteIdentityPool ${deleteIdentityPool.IdentityPoolId}`)
  }
}
(async () => {
  try {
    switch (cli.input[0]) {
      case 'export':
        return main()
      default:
        return cli.showHelp();
    }
  } catch (error) {
    console.log('Unhandled Error');
    console.error(error);
  }
})();

