/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';

var utils = require('fabric-client/lib/utils.js');
var logger = utils.getLogger('E2E create-channel');

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var Client = require('fabric-client');
var util = require('util');
var fs = require('fs');
var path = require('path');
var grpc = require('grpc');

var _commonProto = grpc.load(path.join(__dirname, '../../../fabric-client/lib/protos/common/common.proto')).common;
var _configtxProto = grpc.load(path.join(__dirname, '../../../fabric-client/lib/protos/common/configtx.proto')).common;

var testUtil = require('../../unit/util.js');
var e2eUtils = require('./e2eUtils.js');

var the_user = null;

var ORGS;

var channel_name = 'mychannel';
// can use "channel=<name>" to control the channel name from command line
if (process.argv.length > 2) {
	if (process.argv[2].indexOf('channel=') === 0) {
		channel_name = process.argv[2].split('=')[1];
	}
}

//
//Attempt to send a request to the orderer with the createChannel method
//
test('\n\n***** SDK Built config update  create flow  *****\n\n', function(t) {
	testUtil.resetDefaults();
	Client.addConfigFile(path.join(__dirname, './config.json'));
	ORGS = Client.getConfigSetting('test-network');

	//
	// Create and configure the test channel
	//
	var client = new Client();

	var caRootsPath = ORGS.orderer.tls_cacerts;
	let data = fs.readFileSync(path.join(__dirname, caRootsPath));
	let caroots = Buffer.from(data).toString();

	var TWO_ORG_MEMBERS_AND_ADMIN = [{
		role: {
			name: 'member',
			mspId: 'Org1MSP'
		}
	}, {
		role: {
			name: 'member',
			mspId: 'Org2MSP'
		}
	}, {
		role: {
			name: 'admin',
			mspId: 'OrdererMSP'
		}
	}];

	var ONE_OF_TWO_ORG_MEMBER = {
		identities: TWO_ORG_MEMBERS_AND_ADMIN,
		policy: {
			'1-of': [{ 'signed-by': 0 }, { 'signed-by': 1 }]
		}
	};

	var ACCEPT_ALL = {
		identities: [],
		policy: {
			'0-of': []
		}
	};

	var config = null;
	var signatures = [];
	var orderer = null;
	var orderer_bad = null;
	var orderer_bad2 = null;
	var tlsInfo = null;

	// Acting as a client in org1 when creating the channel
	var org = ORGS.org1.name;

	utils.setConfigSetting('key-value-store', 'fabric-client/lib/impl/FileKeyValueStore.js');

	return e2eUtils.tlsEnroll('org1')
	.then((enrollment) => {
		t.pass('Successfully retrieved TLS certificate');
		tlsInfo = enrollment;
		return Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(org)});
	}).then((store) => {
		client.setStateStore(store);
		var cryptoSuite = Client.newCryptoSuite();
		cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(org)}));
		client.setCryptoSuite(cryptoSuite);

		return testUtil.getOrderAdminSubmitter(client, t);
	}).then((admin) =>{
		t.pass('Successfully enrolled user \'admin\' for orderer (create_channel 1)');

		orderer = client.newOrderer(
			ORGS.orderer.url,
			{
				'pem': caroots,
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS.orderer['server-hostname']
			}
		);

		orderer_bad = client.newOrderer(
			ORGS.orderer.url,
			{
				'pem': caroots,
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS.orderer['server-hostname'],
				'grpc.max_send_message_length': 6800
			}
		);

		// set something to fail to test that the code picks up values from the config
		let keep = Client.getConfigSetting('grpc.max_send_message_length');
		Client.setConfigSetting('grpc.max_send_message_length', 6800);
		orderer_bad2 = client.newOrderer(
			ORGS.orderer.url,
			{
				'pem': caroots,
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS.orderer['server-hostname'],
				'grpc.max_send_message_length': 6800
			}
		);
		// put back the setting
		Client.setConfigSetting('grpc.max_send_message_length',keep);

		// use the config update created by the configtx tool
		let envelope_bytes = fs.readFileSync(path.join(__dirname, '../../fixtures/channel/mychannel.tx'));
		config = client.extractChannelConfig(envelope_bytes);
		t.pass('Successfull extracted the config update from the configtx envelope');

		client._userContext = null;
		return testUtil.getSubmitter(client, t, true /*get the org admin*/, 'org1');
	}).then((admin) => {
		t.pass('Successfully enrolled user \'admin\' for org1');

		// sign the config
		var signature = client.signChannelConfig(config);
		// convert signature to a storable string
		// fabric-client SDK will convert back during create
		var string_signature = signature.toBuffer().toString('hex');
		t.pass('Successfully signed config update');
		// collect signature from org1 admin
		// TODO: signature counting against policies on the orderer
		// at the moment is being investigated, but it requires this
		// weird double-signature from each org admin
		signatures.push(string_signature);
		signatures.push(string_signature);

		// make sure we do not reuse the user
		client._userContext = null;
		return testUtil.getSubmitter(client, t, true /*get the org admin*/, 'org2');
	}).then((admin) => {
		t.pass('Successfully enrolled user \'admin\' for org2');

		// sign the config
		var signature = client.signChannelConfig(config);
		t.pass('Successfully signed config update');

		// collect signature from org2 admin
		// TODO: signature counting against policies on the orderer
		// at the moment is being investigated, but it requires this
		// weird double-signature from each org admin
		signatures.push(signature);
		signatures.push(signature);

		// make sure we do not reuse the user
		client._userContext = null;
		return testUtil.getOrderAdminSubmitter(client, t);
	}).then((admin) => {
		t.pass('Successfully enrolled user \'admin\' for orderer (create_channel 2)');
		the_user = admin;

		// sign the config
		var signature = client.signChannelConfig(config);
		t.pass('Successfully signed config update');

		// collect signature from orderer org admin
		// TODO: signature counting against policies on the orderer
		// at the moment is being investigated, but it requires this
		// weird double-signature from each org admin
		signatures.push(signature);
		signatures.push(signature);

		logger.debug('\n***\n done signing \n***\n');

		// build up a create request to include
		// an orderer that will fail because the
		// orderer is defined with a bad options value
		let tx_id = client.newTransactionID();
		var request = {
			config: config,
			signatures : signatures,
			name : channel_name,
			orderer : orderer_bad,
			txId  : tx_id
		};

		// send create request to bad orderer
		return client.createChannel(request);
	}).then((result) => {
		logger.debug('\n***\n completed the create \n***\n');

		logger.debug(' response ::%j',result);
		t.fail('Failed when this Successfully created the channel.');
		t.end();
		throw new Error('Failed to get max send error');
	}, (err) => {
		if(err.toString().indexOf('Sent message larger than max') > -1) {
			t.pass('Successfully failed with max error on the create channel: ' + err.toString());
		} else {
			t.fail('Failed to fail with max error on the create channel: ' + err.stack ? err.stack : err);
		}

		return true;
	}).then((nothing) => {
		// build up a create request to
		// an orderer that will fail

		let tx_id = client.newTransactionID();
		var request = {
			config: config,
			signatures : signatures,
			name : channel_name,
			orderer : orderer_bad2,
			txId  : tx_id
		};

		// send create request to bad orderer
		return client.createChannel(request);
	}).then((result) => {
		logger.debug('\n***\n completed the create \n***\n');

		logger.debug(' response ::%j',result);
		t.fail('Failed when this Successfully created the channel.');
		t.end();
		throw new Error('Failed to get max send error');
	}, (err) => {
		if(err.toString().indexOf('Sent message larger than max') > -1) {
			t.pass('Successfully failed with max error on the create channel: ' + err.toString());
		} else {
			t.fail('Failed to fail with max error on the create channel: ' + err.stack ? err.stack : err);
		}

		return true;
	}).then((nothing) => {
		// build up the create request
		let tx_id = client.newTransactionID();
		var request = {
			config: config,
			signatures : signatures,
			name : channel_name,
			orderer : orderer,
			txId  : tx_id
		};

		// send create request to orderer
		return client.createChannel(request);
	}).then((result) => {
		logger.debug('\n***\n completed the create \n***\n');

		logger.debug(' response ::%j',result);
		t.pass('Successfully created the channel.');
		if(result.status && result.status === 'SUCCESS') {
			return e2eUtils.sleep(5000);
		} else {
			t.fail('Failed to create the channel. ');
			t.end();
		}
	}, (err) => {
		t.fail('Failed to create the channel: ' + err.stack ? err.stack : err);
		t.end();
	}).then((nothing) => {
		t.pass('Successfully waited to make sure new channel was created.');
		t.end();
	}, (err) => {
		t.fail('Failed to sleep due to error: ' + err.stack ? err.stack : err);
		t.end();
	});
});
