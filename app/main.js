//handle setupevents as quickly as possible
const setupEvents = require('./../installers/setupEvents')
if (setupEvents.handleSquirrelEvent()) {
	// squirrel event handled and app will exit in 1000ms, so don't do anything else
	return;
}
const electron = require('./electron.js');
const OverlayServer = require('./server.js');
const database = require('./db.js');
const ensure = require('./ensure.js');
const fs = require('fs-extra');
const path = require('path');
const nedb = require("@seald-io/nedb");
const { Notification, dialog } = require('electron');
const { ipcMain } = require('./electron.js');
const ObsIntegration = require('./plugins/obs.js');
const Scryfall = require('./plugins/scryfall.js');
var scryfallUpdateRunning = false;

if(process.platform !== "win32"){
	if(!fs.existsSync(path.join(electron.APP.getPath("home"), 'MTG Stream Tool'))){
		if(setupEvents.handleAppImageEvent()){
			electron.APP.relaunch();
			electron.APP.exit();
		}
		return;
	}
	// 	var path =
}
var obs = new ObsIntegration;

global.ARGV = { argv: {} };
process.argv.forEach((arg) => {
	if (arg.startsWith("--")) {
		arg = arg.split("=");
		global.ARGV[arg[0].substr(2)] = arg[1] || null;
	}
});

_debug = global.ARGV.hasOwnProperty("inspect") && global.ARGV.inspect !== 'false';

var APPROOT = global.APPROOT = electron.APP.getAppPath();
var APPRES = global.APPRES = electron.APP.getAppPath();
var APPUSERDATA = global.APPUSERDATA = electron.APP.getPath("userData");
function folder() {
	if (process.platform === "win32") {
		return (path.join(APPROOT, 'js'));
	} else {
		return (path.join(APPROOT, 'js'));
	}
}
var sessionTimestamp = new Date().getTime();
var clientSettings = new nedb({ filename: path.join(APPUSERDATA, 'settings.db'), autoload: true });
async function initScryfall() {
	clientSettings.find({name: "scryfall-lastUpdated"}, async (e, row) => {
		var lastUpdated = null;
		if (e || !row || !row[0]) {
			console.log("No Scryfall last update timestamp found, initializing with null.");
			clientSettings.insert({name: "scryfall-lastUpdated", value: null});
		} else {
			console.log("Scryfall last update timestamp found:", row[0].value);
			lastUpdated = row[0].value;
		}
		console.log(lastUpdated);
		var scryfall = new Scryfall;
		scryfall.lastCreated = lastUpdated;
		scryfall.nedb = new nedb({
			filename: path.join(electron.APP.getPath("home"), 'MTG Stream Tool', 'db', 'card'),
			autoload: true
		});
		scryfall.on("fetchingBulkData", () => {
			console.log("Fetching Scryfall bulk data...");
			scryfallUpdateRunning = true;
			server.broadcast({type: 'scryfallBulkDataUpdate', data: {status: 'start'}});
			electron.send('scryfallBulkDataUpdate', {status: 'start'});
		});
		scryfall.on("noUpdateNeeded", () => {
			server.broadcast({type: 'scryfallBulkDataUpdate', data: {status: 'upToDate'}});
			electron.send('scryfallBulkDataUpdate', {status: 'upToDate'});
			scryfallUpdateRunning = false;
		});
		scryfall.on('insertingCard', (data) => {
			server.broadcast({
				type: 'scryfallBulkDataUpdate', data: {
					status: 'inserting', progress: {
						current: data.current,
						total: data.total,
						percentage: ((data.current / data.total) * 100).toFixed(2)
					}
				}
			});
			electron.send('scryfallBulkDataUpdate', {
				status: 'inserting', progress: {
					current: data.current,
					total: data.total,
					percentage: ((data.current / data.total) * 100).toFixed(2)
				}
			});
			// console.log(`Inserting card ${data.current} of ${data.total} (${((data.current / data.total) * 100).toFixed(2)}%)`);
		});
		scryfall.on('updateFinished', (data) => {
			clientSettings.update({"name": "scryfall-lastUpdated"}, {
				"name": "scryfall-lastUpdated",
				"value": scryfall.lastCreated
			}, {upsert: true});
			console.log("Scryfall bulk data update finished.");
			scryfallUpdateRunning = false;
			server.broadcast({type: 'scryfallBulkDataUpdate', data: {status: 'finished'}});
			electron.send('scryfallBulkDataUpdate', {status: 'finished'});
		})
		scryfall.updateCards();

	});
}


// init server
let server = new OverlayServer();
function port() {
	if (process.platform === "win32") {
		return (80);
	} else {
		return (8000);
	}
}
server.port = global.ARGV.port || port();
server.root = folder();

electron.ipcMain.once('updateScryfall', async () => {
	initScryfall();
});
server.on("listening", function() {
	electron.createMainWindow();
	});
server.on("themefolder-changed", () => electron.send("themefolder-changed"));
server.on("port-in-use", () => {
	dialog.showMessageBox({ message: `Port ${server.port} is already in use on this machine. \nClosing program.` });
	process.exit(1);
});
server.on("api", async (data, cb) => {
	// console.log(data);
	if (data.name == "version") {
		data.version = electron.APP.getVersion();
		cb(data);
	}
	if (data.name == "player") {
		data.player = await database.get("player");
		cb(data);
	}
});

electron.on("ready", async () => { // programm is ready
	APPRES = global.APPRES = (await getClientSetting("resPath")) || path.join(electron.APP.getPath("home"), 'MTG Stream Tool');

	// make sure everything is alright
	await ensure(APPRES, APPROOT, APPUSERDATA);

	database.setPath(APPRES);
	database.newDb(['dbstruct', 'player', 'country', 'team', 'match', 'pride', 'region', 'card']);
	await database.load();

	server.webPath = APPRES;
	server.setTheme((await getClientSetting("theme")));
	server.start();
});

server.on('data-getPlayersByStartGGId', async (data, cb) => {
	console.log(data);
	let randomId = data.mid;
	let startGGIds = data.data;
	let returnData = []
	if(Array.isArray(startGGIds)) {
		for(let i = 0; i < startGGIds.length; i++) {
			let id = startGGIds[i].toString();
			returnData = returnData.concat(await database.get("player", {  "smashgg": id  }));
		}
	}else{
		startGGIds = startGGIds.toString();
		returnData = returnData.concat(await database.get("player", {  "smashgg": startGGIds  }));
	}
	server.sendToID({ type: 'getPlayersByStartGGId-' + randomId, data: await returnData }, data.id);

});

electron.ipcMain.on('switchScene', (event, name) => {
	obs.setCurrentScene(name)
});
obs.on('CurrentSceneChanged', (data) =>{
	// console.log('obs scene changed to:', data);
	electron.send("obsCurrentSceneChanged", data);
	server.broadcast({ type: 'obsSceneChanged', data: data })
})

obs.on('SceneListChanged', (data) =>{
	// console.log('obs scene changed to:', data);
	electron.send("obsSceneListChanged", data);
	server.broadcast({ type: 'obsSceneList', data: data })
})
var startedOnce = false;


electron.ipcMain.on('obsIp', (event, name) => {obs.setIp(name)});
electron.ipcMain.on('obsPort', (event, name) => {obs.setPort(name)});
electron.ipcMain.on('obsPassword', (event, name) => {obs.setPassword(name)});
electron.ipcMain.on('obs', (event, name) => {obsChanger(event, name)});
async function obsChanger(event, name) {
	if(name == "start"){
		let returnVal = await obs.startObs();
		if(returnVal == true){
			electron.send("obs_status", 'connected');
		}
	}
	else{
		obs.stopObs();
		electron.send("obs_status", 'disconnected');
	}
}


electron.ipcMain.on('apiPassword', (event, name) => {server.apiPassword = name;});
electron.ipcMain.on('theme', (event, name) => applyTheme(name));

electron.ipcMain.handle('get', async (event, name) => {
	return await new Promise((resolve, reject) => {
		switch (name) {
			case "settings":
				clientSettings.find({}, (e, rows) => resolve(rows));
				break;
			case "smashgg-token":
				clientSettings.find({ "name": "smashgg-token" }, (e, row) => {
					if (e || !row || !row[0]) {
						resolve("");
					} else {
						resolve(row[0].value);
					}
				});
				break;
			default:
				clientSettings.find({ "name": name }, (e, row) => {
					if (e || !row || !row[0]) {
						resolve("");
					} else {
						resolve(row[0].value);
					}
				});
				break;
		}
	});
});

electron.ipcMain.handle('set', async (event, name, value) => {
	return await new Promise((resolve, reject) => {
		switch (name) {
			default:
				clientSettings.update({ "name": name }, { "name": name, "value": value }, { upsert: true }, (e, r) => resolve(true));
				break;
		}
	});
});

electron.on('settings', (arg) => clientSettings.update({ "name": arg.name }, { "name": arg.name, "value": arg.value }, { upsert: true }));

function applyTheme(name) {
	server.setTheme(name);
	clientSettings.update({ "name": "theme" }, { "name": "theme", "value": name }, { upsert: true });
}

function getClientSetting(name) {
	return new Promise((resolve, reject) => {
		clientSettings.findOne({ name }, (e, doc) => resolve(doc ? doc.value : null));
	});
}


exports.database = database;


process.on("uncaughtException", (err) => {
	const messageBoxOptions = {
		type: "error",
		title: "Error in Main process",
		message: "Something failed"
	};
});

function showNotification(title, body, silent = true) {
	let notification = new Notification({
		title: title == null ? electron.APP.getName() : title, body: body, silent: silent, icon: path.join(__dirname, 'logo.png')
	});
    // notification.sound = false;
    notification.show();
	// return notification.close();
}