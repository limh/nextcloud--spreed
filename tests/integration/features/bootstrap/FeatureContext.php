<?php
/**
 * @author Joas Schilling <coding@schilljs.com>
 * @author Thomas Müller <thomas.mueller@tmit.eu>
 *
 * @copyright Copyright (c) 2016, ownCloud, Inc.
 * @license AGPL-3.0
 *
 * This code is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License, version 3,
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License, version 3,
 * along with this program.  If not, see <http://www.gnu.org/licenses/>
 *
 */
require __DIR__ . '/../../vendor/autoload.php';

use Behat\Behat\Context\Context;
use Behat\Behat\Context\SnippetAcceptingContext;
use GuzzleHttp\Client;
use GuzzleHttp\Message\ResponseInterface;

/**
 * Defines application features from the specific context.
 */
class FeatureContext implements Context, SnippetAcceptingContext {

	/** @var array[] */
	protected static $identifierToToken;
	/** @var array[] */
	protected static $tokenToIdentifier;

	/** @var string */
	protected $currentUser;

	/** @var ResponseInterface */
	private $response;

	/** @var \GuzzleHttp\Cookie\CookieJar */
	private $cookieJar;

	/** @var string */
	protected $baseUrl;

	/** @var string */
	protected $lastEtag;

	/**
	 * FeatureContext constructor.
	 */
	public function __construct() {
		$this->cookieJar = new \GuzzleHttp\Cookie\CookieJar();
		$this->baseUrl = getenv('TEST_SERVER_URL');
	}

	/**
	 * @Then /^user "([^"]*)" is participant of the following rooms$/
	 *
	 * @param string $user
	 * @param \Behat\Gherkin\Node\TableNode|null $formData
	 */
	public function userIsParticipantOfRooms($user, \Behat\Gherkin\Node\TableNode $formData = null) {
		$this->setCurrentUser($user);
		$this->sendRequest('GET', '/apps/spreed/api/v1/room');
		$this->assertStatusCode($this->response, 200);

		$rooms = $this->getDataFromResponse($this->response);
		if ($formData === null) {
			PHPUnit_Framework_Assert::assertEmpty($rooms);
			return;
		}


		PHPUnit_Framework_Assert::assertCount(count($formData->getHash()), $rooms, 'Room count does not match');
		PHPUnit_Framework_Assert::assertEquals($formData->getHash(), array_map(function($room) {
			return [
				'id' => self::$tokenToIdentifier[$room['token']],
				'type' => (string) $room['type'],
				'participantType' => (string) $room['participantType'],
				'participants' => implode(', ', array_map(function($participant) {
					return $participant['name'];
				}, $room['participants'])),
			];
		}, $rooms));
	}

	/**
	 * @Then /^user "([^"]*)" (is|is not) participant of room "([^"]*)"$/
	 *
	 * @param string $user
	 * @param string $isParticipant
	 * @param string $identifier
	 */
	public function userIsParticipantOfRoom($user, $isParticipant, $identifier) {
		$this->setCurrentUser($user);
		$this->sendRequest('GET', '/apps/spreed/api/v1/room');
		$this->assertStatusCode($this->response, 200);

		$isParticipant = $isParticipant === 'is';

		$rooms = $this->getDataFromResponse($this->response);

		if ($isParticipant) {
			PHPUnit_Framework_Assert::assertNotEmpty($rooms);
		}

		foreach ($rooms as $room) {
			if (self::$tokenToIdentifier[$room['token']] === $identifier) {
				PHPUnit_Framework_Assert::assertEquals($isParticipant, true, 'Room ' . $identifier . ' found in user´s room list');
				return;
			}
		}

		PHPUnit_Framework_Assert::assertEquals($isParticipant, false, 'Room ' . $identifier . ' not found in user´s room list');
	}

	/**
	 * @Then /^user "([^"]*)" creates room "([^"]*)"$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param \Behat\Gherkin\Node\TableNode|null $formData
	 */
	public function userCreatesRoom($user, $identifier, \Behat\Gherkin\Node\TableNode $formData = null) {
		$this->setCurrentUser($user);
		$this->sendRequest('POST', '/apps/spreed/api/v1/room', $formData);
		$this->assertStatusCode($this->response, 201);

		$response = $this->getDataFromResponse($this->response);
		self::$identifierToToken[$identifier] = $response['token'];
		self::$tokenToIdentifier[$response['token']] = $identifier;
	}

	/**
	 * @Then /^user "([^"]*)" leaves room "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userLeavesRoom($user, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('DELETE', '/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier] . '/participants/self');
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" removes "([^"]*)" from room "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $toRemove
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userRemovesUserFromRoom($user, $toRemove, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest(
			'DELETE', '/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier] . '/participants',
			new \Behat\Gherkin\Node\TableNode([['participant', $toRemove]])
		);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" deletes room "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userDeletesRoom($user, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('DELETE', '/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier]);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" renames room "([^"]*)" to "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $newName
	 * @param string $statusCode
	 */
	public function userRenamesRoom($user, $identifier, $newName, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest(
			'PUT', '/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier],
			new \Behat\Gherkin\Node\TableNode([['roomName', $newName]])
		);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" makes room "([^"]*)" (public|private) with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $newType
	 * @param string $statusCode
	 */
	public function userChangesTypeOfTheRoom($user, $identifier, $newType, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest(
			$newType === 'public' ? 'POST' : 'DELETE',
			'/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier] . '/public'
		);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" adds "([^"]*)" to room "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $newUser
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userAddUserToRoom($user, $newUser, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest(
			'POST', '/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier] . '/participants',
			new \Behat\Gherkin\Node\TableNode([['newParticipant', $newUser]])
		);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" (promotes|demotes) "([^"]*)" in room "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $isPromotion
	 * @param string $participant
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userPromoteDemoteInRoom($user, $isPromotion, $participant, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest(
			$isPromotion === 'promotes' ? 'POST' : 'DELETE',
			'/apps/spreed/api/v1/room/' . self::$identifierToToken[$identifier] . '/moderators',
			new \Behat\Gherkin\Node\TableNode([['participant', $participant]])
		);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" pings call "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userPingsCall($user, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('POST', '/apps/spreed/api/v1/call/' . self::$identifierToToken[$identifier] . '/ping');
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" joins call "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userJoinsCall($user, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('POST', '/apps/spreed/api/v1/call/' . self::$identifierToToken[$identifier]);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" leaves call "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userLeavesCall($user, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('DELETE', '/apps/spreed/api/v1/call/' . self::$identifierToToken[$identifier]);
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @Then /^user "([^"]*)" sees (\d+) peers in call "([^"]*)" with (\d+)$/
	 *
	 * @param string $user
	 * @param string $numPeers
	 * @param string $identifier
	 * @param string $statusCode
	 */
	public function userSeesPeersInCall($user, $numPeers, $identifier, $statusCode) {
		$this->setCurrentUser($user);
		$this->sendRequest('GET', '/apps/spreed/api/v1/call/' . self::$identifierToToken[$identifier]);
		$this->assertStatusCode($this->response, $statusCode);

		if ($statusCode === '200') {
			$response = $this->getDataFromResponse($this->response);
			PHPUnit_Framework_Assert::assertCount((int) $numPeers, $response);
		} else {
			PHPUnit_Framework_Assert::assertEquals((int) $numPeers, 0);
		}
	}

	/**
	 * Parses the xml answer to get the array of users returned.
	 * @param ResponseInterface $response
	 * @return array
	 */
	protected function getDataFromResponse(ResponseInterface $response) {
		return $response->json()['ocs']['data'];
	}

	/**
	 * @Then /^status code is ([0-9]*)$/
	 *
	 * @param int $statusCode
	 */
	public function isStatusCode($statusCode) {
		$this->assertStatusCode($this->response, $statusCode);
	}

	/**
	 * @BeforeScenario
	 * @AfterScenario
	 */
	public function resetSpreedAppData() {
		$client = new Client();
		$options = [
			'auth' => ['admin', 'admin'],
		];

		try {
			return $client->send($client->createRequest('DELETE', getenv('TEST_SERVER_URL') . 'ocs/v2.php/apps/spreedcheats/', $options));
		} catch (\GuzzleHttp\Exception\ClientException $ex) {
			return $ex->getResponse();
		}
	}

	/*
	 * User management
	 */

	/**
	 * @Given /^as user "([^"]*)"$/
	 * @param string $user
	 */
	public function setCurrentUser($user) {
		$this->currentUser = $user;
	}

	/**
	 * @Given /^user "([^"]*)" exists$/
	 * @param string $user
	 */
	public function assureUserExists($user) {
		try {
			$this->userExists($user);
		} catch (\GuzzleHttp\Exception\ClientException $ex) {
			$this->createUser($user);
		}
		$response = $this->userExists($user);
		$this->assertStatusCode($response, 200);
	}

	private function userExists($user) {
		$client = new Client();
		$options = [
			'auth' => ['admin', 'admin'],
			'headers' => [
				'OCS-APIREQUEST' => 'true',
			],
		];
		return $client->get($this->baseUrl . 'ocs/v2.php/cloud/users/' . $user, $options);
	}

	private function createUser($user) {
		$previous_user = $this->currentUser;
		$this->currentUser = "admin";

		$userProvisioningUrl = $this->baseUrl . 'ocs/v2.php/cloud/users';
		$client = new Client();
		$options = [
			'auth' => ['admin', 'admin'],
			'body' => [
				'userid' => $user,
				'password' => '123456'
			],
			'headers' => [
				'OCS-APIREQUEST' => 'true',
			],
		];
		$client->send($client->createRequest('POST', $userProvisioningUrl, $options));

		//Quick hack to login once with the current user
		$options2 = [
			'auth' => [$user, '123456'],
			'headers' => [
				'OCS-APIREQUEST' => 'true',
			],
		];
		$client->send($client->createRequest('GET', $userProvisioningUrl . '/' . $user, $options2));

		$this->currentUser = $previous_user;
	}

	/*
	 * Requests
	 */

	/**
	 * @When /^sending "([^"]*)" to "([^"]*)" with$/
	 * @param string $verb
	 * @param string $url
	 * @param \Behat\Gherkin\Node\TableNode $body
	 * @param array $headers
	 */
	public function sendRequest($verb, $url, $body = null, array $headers = []) {
		$fullUrl = $this->baseUrl . 'ocs/v2.php' . $url;
		$client = new Client();
		$options = [];
		if ($this->currentUser === 'admin') {
			$options['auth'] = ['admin', 'admin'];
		} else {
			$options['auth'] = [$this->currentUser, '123456'];
		}
		if ($body instanceof \Behat\Gherkin\Node\TableNode) {
			$fd = $body->getRowsHash();
			$options['body'] = $fd;
		}

		$options['headers'] = array_merge($headers, [
			'OCS-ApiRequest' => 'true',
			'Accept' => 'application/json',
		]);

		try {
			$this->response = $client->send($client->createRequest($verb, $fullUrl, $options));
		} catch (\GuzzleHttp\Exception\ClientException $ex) {
			$this->response = $ex->getResponse();
		}
	}

	/**
	 * @param ResponseInterface $response
	 * @param int $statusCode
	 */
	protected function assertStatusCode(ResponseInterface $response, $statusCode) {
		PHPUnit_Framework_Assert::assertEquals($statusCode, $response->getStatusCode());
	}

	protected function typeStringToInt($roomType) {
		switch ($roomType) {
			case 'one2one':
				return 1;
			case 'group':
				return 2;
			case 'public':
				return 3;
		}

		throw new \RuntimeException('Invalid room type');
	}
}
