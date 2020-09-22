const { app, ipcMain, globalShortcut } = require("electron");
const MainWindow = require("./Windows/MainWindow");
const SettingsWindow = require("./Windows/settings/SettingsWindow");

const Game = require("./Classes/Game");
const GameHelper = require("./utils/GameHelper");
const game = new Game();

const Store = require("./utils/Store");
const settings = Store.getSettings();

const tmi = require("tmi.js");

const hastebin = require("hastebin.js");
const haste = new hastebin();

let client;
let mainWindow;
let settingsWindow;

const init = () => {
	mainWindow = new MainWindow();
	settingsWindow = new SettingsWindow();
	settingsWindow.setParentWindow(mainWindow);

	mainWindow.webContents.on("did-navigate-in-page", (e, url) => {
		if (GameHelper.isGameURL(url)) {
			mainWindow.webContents.send("in-game", settings.noCar, settings.noCompass);
			if (game.url === url) {
				game.startGame(url).then(() => {
					client.action(settings.channelName, `🌎 Round ${game.getRound()} has started`);
					openGuesses();
				});
			} else {
				game.clearGuesses();
				game.startGame(url).then(() => {
					client.action(settings.channelName, `🌎 A new seed of "${game.seed.mapName}" has started`);
					openGuesses();
				});
			}
		} else {
			game.outGame();
			mainWindow.webContents.send("out-game");
		}
	});

	mainWindow.webContents.on("did-stop-loading", () => {
		if (!game.inGame) return;
		mainWindow.webContents.executeJavaScript(`
				guessBtn = document.querySelector('[data-qa="perform-guess"]');
				if(guessBtn) {
					guessBtn.addEventListener("click", () => ipcRenderer.send('make-guess-click'));
				}
				nextRoundBtn = document.querySelector('[data-qa="close-round-result"]');
				if(nextRoundBtn) {
					nextRoundBtn.addEventListener("click", () => ipcRenderer.send('next-round-click'));
				}
			`);
		if (game.seed.timeLimit != 0 && game.seed.state != "finished") {
			GameHelper.fetchSeed(game.url).then((seedData) => {
				if (seedData.round != game.getRound() || seedData.state === "finished") {
					makeGuess();
				}
			});
		}
	});

	ipcMain.on("game-form", (e, noCar, noCompass) => {
		mainWindow.webContents.send("game-settings-change", noCar, noCompass);
		settingsWindow.hide();
		if (settings.noCar != noCar) {
			mainWindow.reload(); // may cause issues when reloading in game
		}
		settings.setGameSettings(noCar, noCompass);
		Store.setSettings(settings);
	});

	ipcMain.on("twitch-commands-form", (e, guessCmd, userGetStatsCmd, userClearStatsCmd, clearAllStatsCmd, setStreakCmd, showHasGuessed) => {
		settings.setTwitchCommands(guessCmd, userGetStatsCmd, userClearStatsCmd, clearAllStatsCmd, setStreakCmd, showHasGuessed);
		Store.setSettings(settings);
		settingsWindow.hide();
	});

	ipcMain.on("twitch-settings-form", (e, channelName, botUsername, token) => {
		settings.setTwitchSettings(channelName, botUsername, token);
		Store.setSettings(settings);
		if (client.readyState() === "OPEN") client.disconnect();
		loadTmi();
	});

	ipcMain.on("open-guesses", () => openGuesses());
	const openGuesses = () => {
		game.openGuesses();
		mainWindow.webContents.send("switch-on");
		client.action(settings.channelName, "Guesses are open...");
	};

	ipcMain.on("close-guesses", () => {
		closeGuesses();
		client.action(settings.channelName, "Guesses are closed.");
	});
	const closeGuesses = () => {
		game.closeGuesses();
		mainWindow.webContents.send("switch-off");
	};

	ipcMain.on("make-guess-click", () => makeGuess());
	const makeGuess = async () => {
		closeGuesses();
		mainWindow.webContents.send("pre-round-results");
		await game.makeGuess(settings.channelName);
		const sortedGuesses = game.getSortedGuesses();
		mainWindow.webContents.send("show-round-results", game.currentLocation, sortedGuesses);
		const link = await makeHastebin(sortedGuesses, game.getRound(), game.currentLocation);
		client.action(settings.channelName, `🌎 Round ${game.getRound()} has finished. Congrats ${sortedGuesses[0].username}! Check out the round results here: ${link}`);
	};

	ipcMain.on("next-round-click", () => nextRound());
	const nextRound = () => {
		game.nextRound();
		if (game.seed.state === "finished") {
			processTotalResults();
		} else {
			mainWindow.webContents.send("next-round");
			client.action(settings.channelName, `🌎 Round ${game.getRound()} has started`);
			openGuesses();
		}
	};

	const processTotalResults = async () => {
		const totalResults = game.getSortedTotal();
		const link = await makeHastebin(totalResults);
		mainWindow.webContents.send("show-total-results", totalResults);
		client.action(settings.channelName, `🌎 Game finished. Congrats ${totalResults[0].username} 🏆! Check out the full results here: ${link}`);
	};

	const makeHastebin = (results, round, location) => {
		let str = `# ${game.seed.mapName} ${round ? "Round " + round : "Total"} Highscores :
${"=".repeat(game.seed.mapName.length + (round ? 23 : 19))}
`;
		results.forEach((guess, index) => {
			str += `
${index + 1}.${index + 1 <= 10 ? "  " : " "}${guess.username}${" ".repeat(30 - guess.username.length)}${" ".repeat(5 - guess.score.toString().length)}${guess.score}${
				round ? "" : " [" + guess.nbGuesses + "]"
			}`;
		});
		if (location) {
			const url = `http://maps.google.com/maps?q=&layer=c&cbll=${location.lat},${location.lng}`;
			str += `

${url}
${"=".repeat(url.length)}`;
		}
		return haste.post(str).then((link) => link);
	};

	ipcMain.on("clearStats", () => clearStats());

	globalShortcut.register("CommandOrControl+R", () => false);
	// globalShortcut.register("CommandOrControl+Shift+R", () => false);
	globalShortcut.register("Escape", () => settingsWindow.hide());
	globalShortcut.register("CommandOrControl+P", () => {
		settingsWindow.webContents.send("render-settings", settings);
		settingsWindow.show();
	});
};

const loadTmi = () => {
	const options = {
		options: { debug: true },
		connection: {
			secure: true,
			reconnect: true,
		},
		identity: {
			username: settings.botUsername,
			password: settings.token,
		},
		channels: [settings.channelName],
	};
	client = new tmi.Client(options);
	client.connect(tmiListening()).catch((error) => {
		settingsWindow.webContents.send("twitch-error", error);
		console.error(error);
	});
};

const tmiListening = () => {
	client.on("connected", () => {
		settingsWindow.webContents.send("twitch-connected");
		client.action(settings.channelName, "is now connected");
	});

	client.on("disconnected", () => {
		settingsWindow.webContents.send("twitch-disconnected");
	});

	client.on("whisper", async (from, userstate, message, self) => {
		if (self) return;
		if (game.guessesOpen && message.startsWith(settings.guessCmd)) {
			message = message.split(settings.guessCmd)[1].trim();
			if (!GameHelper.isCoordinates(message)) return;

			if (game.hasGuessedThisRound(userstate.username)) {
				return client.say(settings.channelName, `${userstate["display-name"]} you already guessed`);
			}

			const guessLocation = { lat: parseFloat(message.split(",")[0]), lng: parseFloat(message.split(",")[1]) };
			if (game.hasPastedPreviousGuess(userstate.username, guessLocation)) {
				return client.say(settings.channelName, `${userstate["display-name"]} seems like you pasted your previous guess :)`);
			}

			game.processUserGuess(userstate, guessLocation).then((res) => {
				const { guess, nbGuesses } = res;
				mainWindow.webContents.send("render-user-guess", guess, nbGuesses);
				if (settings.showHasGuessed) return client.say(settings.channelName, `${userstate["display-name"]} guessed`);
			});
		}
	});

	client.on("chat", (channel, userstate, message, self) => {
		if (self) return;
		if (message.toLowerCase() === settings.userGetStatsCmd) {
			const userInfo = Store.getUser(userstate.username);
			if (userInfo) {
				return client.say(
					channel,
					`
						${userstate["display-name"]}: Current streak: ${userInfo.streak}.
						Best streak: ${userInfo.bestStreak}.
						Correct countries: ${userInfo.correctGuesses}/${userInfo.nbGuesses} (${((userInfo.correctGuesses / userInfo.nbGuesses) * 100).toFixed(2)}%).
						Avg. score: ${Math.round(userInfo.meanScore)}.
						Perfects: ${Math.round(userInfo.nbPerfect)}.
					`
				);
			} else {
				return client.say(channel, `${userstate["display-name"]} you've never guessed yet.`);
			}
		}

		if (message.toLowerCase() === "!best") {
			const storedUsers = Store.getUsers();
			if (!storedUsers) return client.say(channel, `No streak established yet.`);
			const bestStreak = Math.max(...Object.values(storedUsers).map((o) => o.streak));
			const user = Object.keys(storedUsers).filter((user) => storedUsers[user].streak === bestStreak);
			return client.say(channel, `Channel best streak: ${bestStreak} by ${user}`);
		}

		if (message.toLowerCase() === settings.userClearStatsCmd) {
			const userInfo = Store.getUser(userstate.username);
			if (!userInfo) return client.say(channel, `${userstate["display-name"]} you've never guessed yet.`);
			Store.deleteUser(userstate.username);
			return client.say(channel, `${userstate["display-name"]} 🗑️ stats cleared !`);
		}

		if (userstate.username != settings.channelName) return; // !streamer commands

		if (message.toLowerCase().startsWith(settings.setStreakCmd)) {
			const msgArr = message.split(" ");
			if (msgArr.length != 3) return client.action(channel, `Valid command: ${settings.setStreakCmd} user 42`);
			const newStreak = parseFloat(msgArr[2]);
			if (!Number.isInteger(newStreak)) return client.action(channel, `Invalid number.`);
			if (msgArr[1].charAt(0) === "@") msgArr[1] = msgArr[1].substring(1);
			const user = msgArr[1].toLowerCase();
			const storedUser = Store.getUser(user);
			if (!storedUser) return client.action(channel, `${user} has never guessed.`);
			Store.setUserStreak(user, newStreak);
			return client.action(channel, `${user} streak set to ${newStreak}`);
		}

		if (message.toLowerCase() === settings.clearAllStatsCmd) clearStats();
	});
};

const clearStats = () => {
	Store.clearStats();
	client.action(settings.channelName, "🗑️ All stats have been cleared.");
};

app.whenReady().then(init).then(loadTmi);
