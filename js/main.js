const {shell, ipcMain} = require('electron');
const fs = require('fs');
const path = require("path");
const emitter = new (require("events"))();

const APPROOT = remote.getGlobal("APPROOT").replace(/\\/g, '/');
const APPRES = remote.getGlobal("APPRES").replace(/\\/g, '/');

var _ws, _cons, _theme;
var _timeouts = {};

var _callbacks = {on: {}, once: {}, hold: []}; // callbacks for on,once & fire

var matchList = [];

var scoreboard = {
    id: null,
    players: [],
    caster: [],
    seatorder: [],
    matchformat: {
        type: 0,
        value: 0,
    },
    fields: {},
    highlightedCard: {
        card: {},
        side: "front",
        rotation: 0
    },
    startgg: {
        set: null,
        event: null,
        phaseGroup: null,
        phase: null
    },
    smashggtoken: null,
    _D: null
};
var streamQueue = [];
var obs = {
    currentScene: ""
}
var usedTournamentWebsite = null;


var client = {
    autoupdate: false,
    autoupdateThreshold: 500,
    playerSize: null,
    fixedSidebar: true
};

var portAmount = 4;
var minAmountPlayers = 2;
var maxAmountPlayers = 4;

addEventListener("load", () => fire("load"));

remoteOn(db, "player-changed", playerChangedHandler);
remoteOn(db, "player-changed", buildPlayerAutoCompleteList);

on("load", init);
on("load", buildPlayerAutoCompleteList);
// on("load", buildCardAutoCompleteList);
on("load", clockUpdate);
on("scoreboardchanged", autoUpdate);
on("scoreboardchanged", insertHighlightedCardUI);
on("scoreboardteamschanged", changePlayerAmount);
on("scoreboardteamschanged", insertPlayerUI);
on("scoreboardcasterchanged", insertCasterUI);
on("themechanged", buildFieldList);
on("themechanged", insertScoreboardData);
on("themechanged", changePlayerAmount);

once("themechanged", buildThemeSelection);
on("streamqueuechanged", streamqueuechanged);

ipcRenderer.on("themefolder-changed", buildThemeSelection);

ipcRenderer.on('scryfallBulkDataUpdate', (e, data) => {
    switch (data.status){
        case "start":
            document.getElementById("scryfall-status").innerText = "Scryfall Data: In Progress...";
            break;
        case "upToDate":
            document.getElementById("scryfall-status").innerText = "Scryfall Data: Up to Date";
            // buildCardAutoCompleteList();
            break;
        case "inserting":
            document.getElementById("scryfall-status").innerText = `Scryfall Data: Inserting Cards... (${data.progress.current} / ${data.progress.total}) ${data.progress.percentage}%`;
            break;
        case "finished":
            document.getElementById("scryfall-status").innerText = "Scryfall Data: Up to Date";
            // buildCardAutoCompleteList();
    }
});
async function changePlayerAmount() {
    var themeMinAmount = _theme.playerminamount != null ? _theme.playerminamount : 2;
    var themeMaxAmount = _theme.playermaxamount != null ? _theme.playermaxamount : 4;
    minAmountPlayers = themeMinAmount;
    maxAmountPlayers = themeMaxAmount;
    document.getElementById('playersize-select').min = themeMinAmount;
    document.getElementById('playersize-select').max = themeMaxAmount;
        if (scoreboard.players.length < themeMinAmount) {
            setPlayerSize(themeMinAmount);
        } else if (scoreboard.players.length > themeMaxAmount) {
            setPlayerSize(themeMaxAmount);
        }
}
async function init() {
    hold("scoreboardchanged");
    bgWork.start("init");

    await applyClientSettings(await ipcRenderer.invoke("get", "settings"));

    // failsafe if theme is not defined in settings
    if (_theme == null) {
        await setTheme((await ThemeWrapper.getTheme(0)).name);
    }


    fs.readFile(path.join(remote.app.getPath('userData'),'scoreboard.json'), 'utf8', (err, data) => {
        if (!err) {
            try {
                scoreboard = Object.assign(scoreboard, JSON.parse(data));
            } catch (e) {
            }
        }
        setPlayerSize(Math.max(scoreboard.players.length, 2));
        insertScoreboardData(scoreboard);
        release("scoreboardchanged");
    });


    _ws = new WSWrapper(null, remote.getGlobal("ARGV").port);

    _ws.on("open", () => _ws.send(JSON.stringify({"type": "subscribe", "data": "*"})));
    _ws.on("open", () => fire("ws-ready"));
    _ws.on("data-cmd", handleWsCommand);

    // Update Button animation script
    let updateBtn = document.getElementById('update-btn');
    on("update", () => {
        updateBtn.classList.remove("changed", "anim");
        void updateBtn.offsetWidth;
        updateBtn.classList.add("anim");
    });
    on("scoreboardchanged", () => updateBtn.classList.add("changed"));
    updateBtn.getElementsByTagName("img")[1].addEventListener("animationend", e => e.srcElement.parentNode.classList.remove("anim"));

    document.getElementById('version').innerText = "v " + remote.app.getVersion();

    bgWork.finish("init");
}

// hotkeys
window.addEventListener("keydown", (e) => {
    if (e.ctrlKey) {
        switch (e.keyCode) {
            case 83:
                update();
                break; // CTRL + S => update
            default:
                return;
        }
        e.preventDefault();
    }
}, true);

let smashggToken = "";
let showsmashggToken = false;
let obsSceneList = [];
let obsSceneListValues = {};
let obsSceneListSelected = {};

async function applyClientSettings(settings) {
    console.log(settings)
    for (let row of settings) {
        switch (row.name) {
            case "theme":
                await setTheme(row.value);
                break;
            case "smashgg-token":
                smashggToken = row.value;
                smashgg.Token = row.value;
                if (showsmashggToken) {
                    scoreboard.smashggtoken = row.value;
                } else {
                    scoreboard.smashggtoken = "";
                }
                break;
            case "showSmashggToken":
                showsmashggToken = row.value;
                if (row.value) {
                    scoreboard.smashggtoken = smashggToken;
                } else {
                    scoreboard.smashggtoken = "";
                }
                break;
            case "autoupdate":
                toggleAutoUpdate(row.value);
                break;
            case "tournamentWebsite":
                usedTournamentWebsite = row.value;
                break;
            case "autoupdateThreshold":
                client.autoupdateThreshold = row.value;
                break;
            case "fixedSidebar":
                client.fixedSidebar = row.value;
                document.body.classList.toggle("fixedSidebar", row.value);
                break;
            case "fixedStreamQueue":
                client.fixedStreamQueue = row.value;
                document.body.classList.toggle("fixedStreamQueue", row.value);
                break;
            case "connection-type":
                ipcRenderer.send("connectionType", row.value);
                break;
            case "obs-ip":
                ipcRenderer.send("obsIp", row.value);
                break;
            case "obs-port":
                ipcRenderer.send("obsPort", row.value);
                break;
            case "obs-password":
                ipcRenderer.send("obsPassword", row.value);
                break;
            case "obsCurrentScene":
                // console.log("obsCurrentScene", row.value);
                break;
            case "obsSceneList":
                // console.log("obsSceneList", row.value);
                obsSceneList = row.value;
                changeObsDropdown();
                break;
            case "obsSceneListValues":
                // console.log("obsSceneListValues", row.value);
                obsSceneListValues = row.value;
                break;
            case "obsSceneListSelected":
                // console.log("obsSceneList", row.value);
                obsSceneListSelected = row.value;
                obsSceneListSelectedInit();
                break;
            case "enable-obs":
                ipcRenderer.send("enableObs", row.value);
                showObs(row.value);
                break;
            case 'apiPassword':
                ipcRenderer.send("apiPassword", row.value);
                break;

        }
    }
}
function obsSceneListSelectedInit(){
    let buttons = document.getElementsByClassName("obsSceneButtons");
    for(let i = 0; i < buttons.length; i++){
        let button = buttons[i];
        if(obsSceneListSelected[button.id] != undefined){
            button.checked = obsSceneListSelected[button.id];
        }
    }
}
document.addEventListener("DOMContentLoaded", () => {
    Array.prototype.forEach.call(document.getElementsByClassName("obsSceneButtons"), (el) => {
        el.onclick = (e) => {
            let id = e.target.id;
            obsSceneListSelected[id] = e.target.checked;
            ipcRenderer.invoke("set", "obsSceneListSelected", obsSceneListSelected);
            applyClientSettings([{name: 'obsSceneListSelected', value: obsSceneListSelected}]);
        }
    });
});
function changeObsDropdown() {
    let dropdowns = document.getElementsByClassName("obsSceneDropdown");
    for (let i = 0; i < dropdowns.length; i++) {
        let dropdown = dropdowns[i];
        let dropdownSelected = '';
        if(obsSceneListValues[dropdown.id] != undefined) {
            dropdownSelected = obsSceneListValues[dropdown.id];
        }
        dropdown.innerHTML = "";

        let option = document.createElement("option");
        option.text = '';
        option.value = '';
        dropdown.add(option);
        for (let j = 0; j < obsSceneList.length; j++) {
            let option = document.createElement("option");
            option.text = obsSceneList[j];
            option.value = obsSceneList[j];
            dropdown.add(option);
            if (option.text === dropdownSelected) {
                dropdown.selectedIndex = j + 1;
            }
        }
    }

    Array.prototype.forEach.call(document.getElementsByClassName("obsSceneDropdown"), (el) => {
        el.onchange = (e) => {
            let id = e.target.id;
            obsSceneListValues[id] = e.target.value;
            ipcRenderer.invoke("set", "obsSceneListValues", obsSceneListValues);
            applyClientSettings([{name: 'obsSceneListValues', value: obsSceneListValues}]);
        }
    });
}

async function openSettingsWindow() {
    await openWindow('settings', null, true);
    let clientSettings = await ipcRenderer.invoke("get", "settings");
    console.log(clientSettings);
    applyClientSettings(clientSettings);
}

function buildTeamPlayerList() {
    let playerAmount = scoreboard.players.length;
    console.log(playerAmount);
    let tpl = document.getElementById("sb-player-tpl");
        let teamPlayerField = document.getElementById('sb-players').truncate();
        for (let i = 0; i < playerAmount; i++) {
            let playerItemEl = createElement({
                "type": "div",
                "className": "player-item",
                "id": "playeritem-" + i,
                "append": tpl.content.cloneNode(true)
            });
            playerItemEl.innerHTML = playerItemEl.innerHTML.replace(/#INDEX#/g, i);
            let playerNameElm = playerItemEl.querySelector("input.playername");
            let deckNameElm = playerItemEl.querySelector("input.deckname");
            let playerEditBtn = playerItemEl.querySelector(".player-edit-btn");
            let playerAddBtn = playerItemEl.querySelector(".player-create-btn");
            let playerColorBtns = playerItemEl.querySelector(".player-ports").truncate();
            let playerLifeElm = playerItemEl.querySelector(".sb-life-input");
            let playerScoreElm = playerItemEl.querySelector(".sb-score-input");
            playerItemEl.dataset.player = i;

            playerNameElm.id = "playername-" + i;
            playerNameElm.value = scoreboard.players[i].player ? scoreboard.players[i].player.name : "";
            playerNameElm.oninput = playerNameInput;
            deckNameElm.id = "deckname"+ i;
            deckNameElm.value = scoreboard.players[i].deck ? scoreboard.players[i].deck.name : "";
            deckNameElm.oninput = deckNameInput;
            playerEditBtn.onclick = editPlayer;
            playerAddBtn.onclick = editPlayer;
            playerLifeElm.value = scoreboard.players[i].life ? scoreboard.players[i].life : 20;
            playerScoreElm.value = scoreboard.players[i].score ? scoreboard.players[i].score : 0;


            const manaColor = [
                'w', 'u', 'b', 'r', 'g'
            ];
            playerColorBtns.id = "playercolors-" + i;
            for (let portNum = 0; portNum <= portAmount; portNum++) {

                let colorBtn = document.createElement("div");
                colorBtn.classList.add("port");
                colorBtn.classList.add("ms");
                colorBtn.classList.add("ms-" + manaColor[portNum]);
                colorBtn.id = "colorbtn-" + manaColor[portNum] + "-" + i;
                colorBtn.onclick = e => assignPlayerPort(i, manaColor[portNum]);

                if(scoreboard.players[i].deck.colors.includes(manaColor[portNum])){

                    colorBtn.classList.add("checked");
                }
                playerColorBtns.appendChild(colorBtn);
            }

            teamPlayerField.appendChild(playerItemEl);
        }
    fire("scoreboardseatorderchanged");
}

function buildCasterList() {
    let tpl = document.getElementById('caster-item-tpl');
    let el = document.getElementById('caster').truncate();
    for (let casterNum = 0; casterNum < (_theme.caster || 2); casterNum++) {
        let item = createElement({"type": "div", "className": "item", "append": tpl.content.cloneNode(true)});
        let nameTbx = item.querySelector("input");
        // let selectionElm = item.querySelector(".selection");
        let selectedIndex = -1;

        sortable(item, ["div.player-options", ".search"], (indexList) => {
            let newCasterOrder = [];
            indexList.forEach((item) => newCasterOrder.push(scoreboard.caster[item[0]]));
            scoreboard.caster = newCasterOrder;
            insertScoreboardData();
        });

        // open caster selection by focusing the input element
        item.querySelector(".info").onclick = function (e) {
            let el = e.currentTarget.parentNode;
            let tbx = el.querySelector("input");
            el.querySelector(".search").classList.add("visible");
            tbx.value = scoreboard.caster[e.currentTarget.parentNode.getIndex()].name;
            tbx.focus();
            tbx.select();
            e.stopPropagation();
        }

        item.querySelector(".info .player-options .player-edit-btn").onclick = e => {
            editPlayer(scoreboard.caster[e.target.getIndexIn(el)]);
            e.stopPropagation();
        }

        // search through player DB
        nameTxbInput = e => {
            let value = e.target.value.trim().toLowerCase();
            let selectionElm = e.target.parentNode.querySelector(".selection");
            db.get("player", {"name": {$regex: new RegExp(`${RegExp.escape(value)}`, 'i')}}, {limit: 20}).then((list) => {
                list = list.map(x => new Player(x));
                selectionElm.truncate();
                selectedIndex = -1;
                if (value.length > 0) // add temp name entry
                    list.push(new Player({name: e.target.value}));
                list.unshift(new Player());
                selectedIndex = list.length - 1;

                list.forEach((po, index) => {
                    // build caster select items
                    let item = document.createElement("div");
                    item.classList.add("item");
                    item.classList.toggle("tmp", (!po.InDB && po.name.length > 0));
                    item.classList.toggle("clear", (!po.InDB && po.name.length == 0));
                    item.appendChild(createElement({"type": "div", "className": "name", "text": po.name}));

                    if (po.country) {
                        let countryEl = createElement({"type": "img"});
                        countryEl.src = APPRES + '/assets/country/' + po.country + '.png';
                        if (fs.existsSync(APPRES + '/assets/country/' + po.country + '.png')) {
                            countryEl.src = APPRES + '/assets/country/' + po.country + '.png';
                        } else {
                            countryEl.src = APPRES + '/assets/country/' + po.country + '.svg';
                        }
                        countryEl.onerror = e => e.target.remove();
                        item.appendChild(countryEl);
                    }
                    if (po.team) {
                        let teamEl = createElement({"type": "div", "className": "team"});
                        db.get("team", {$or: [].concat(po.team).map(x => ({"_id": x}))})
                            .then(entry => teamEl.innerText = entry.map(x => x.name).join(", "));
                        item.appendChild(teamEl);
                    }
                    if (po.InDB && e.type == "input" && (e.target.value == po.name || list.length == 1)) {
                        selectedIndex = index;
                    }
                    item.classList.toggle("highlighted", selectedIndex == index);

                    item.onclick = e => { // caster select item clicked
                        nameTbx.blur();
                        setCaster(e.target.getIndexIn(document.getElementById('caster')), po);
                    };
                    item.onmousedown = e => e.preventDefault();
                    selectionElm.appendChild(item);
                });

            });
        };

        nameTbx.oninput = nameTxbInput;
        nameTbx.onfocus = nameTxbInput;
        nameTbx.onblur = () => item.querySelector(".search").classList.remove("visible");
        nameTbx.onkeydown = e => {
            let selectionElm = e.target.parentNode.querySelector(".selection");
            if (e.code == "ArrowDown") {
                if (selectedIndex == -1)
                    selectedIndex++;
                selectedIndex++;
                e.preventDefault();
            }
            if (e.code == "ArrowUp") {
                selectedIndex--;
                if (selectedIndex < 0)
                    selectedIndex = 0;
                e.preventDefault();
            }
            if (selectedIndex > -1) {
                if (selectedIndex >= selectionElm.querySelectorAll("div.item").length)
                    selectedIndex = selectionElm.querySelectorAll("div.item").length - 1;
                selectionElm.querySelectorAll("div.item").forEach(el => el.classList.remove("highlighted"));
                let selectedElm = selectionElm.querySelector("div.item:nth-child(" + (selectedIndex + 1) + ")");
                selectedElm.classList.add("highlighted");
                let height = parseInt(document.defaultView.getComputedStyle(selectedElm, '').getPropertyValue('height').substr(0, 2));
                selectionElm.scrollTop = selectedIndex * height - 150;
                if (e.code == "Enter") {
                    selectedElm.click();
                    e.preventDefault();
                }
            }
        }
        el.appendChild(item);
        insertCasterUI();

        // casterEl.querySelector(".info .twitter").innerText = co.twitter;
    }

    // decrease casters to casterCount
    scoreboard.caster.splice(_theme.caster || 2);
    // increase casters to casterCount
    for (let i = scoreboard.caster.length; i < (_theme.caster || 2); i++) {
        scoreboard.caster.push(new Player());
    }
}

function buildHighlightedCard() {
        let item = document.getElementById('highlighted-card');
        item = item.firstElementChild ? item.firstElementChild : item;
        let nameTbx = item.querySelector("input");
        // let selectionElm = item.querySelector(".selection");
        let selectedIndex = -1;

        // open caster selection by focusing the input element
        item.querySelector(".info").onclick = function (e) {
            console.log(e.target);
            if(e.target.nodeName == "BUTTON" || e.target.parentNode.nodeName == "BUTTON"){
                return;
            }
            let el = e.currentTarget.parentNode;
            let tbx = el.querySelector("input");
            el.querySelector(".search").classList.add("visible");
            tbx.value = scoreboard.highlightedCard.card.name;
            if(tbx.value == "undefined"){
                tbx.value = "";
            }
            tbx.focus();
            tbx.select();
            e.stopPropagation();
        }

        // item.querySelector(".info .player-options .player-edit-btn").onclick = e => {
        //     editPlayer(scoreboard.caster[e.target.getIndexIn(el)]);
        //     e.stopPropagation();
        // }

        // search through player DB
        nameTxbInput = e => {
            let value = e.target.value.trim().toLowerCase();
            let selectionElm = e.target.parentNode.querySelector(".selection");
            db.get("card", {"name": {$regex: new RegExp(`${RegExp.escape(value)}`, 'i')}}, {limit: 20, sort: {"name": 1}}).then((list) => {
                selectionElm.truncate();
                selectedIndex = -1;

                list.forEach((card, index) => {
                    // build caster select items
                    let item = document.createElement("div");
                    item.classList.add("item");
                    item.appendChild(createElement({"type": "div", "className": "name", "text": card.name}));
                    if (e.type == "input" && (e.target.value == card.name || list.length == 1)) {
                        selectedIndex = index;
                    }
                    item.classList.toggle("highlighted", selectedIndex == index);

                    item.onclick = e => { // caster select item clicked
                        nameTbx.blur();
                        setHighlightedCard(card);
                    };
                    item.onmousedown = e => e.preventDefault();
                    selectionElm.appendChild(item);
                });

            });
        };

        nameTbx.oninput = nameTxbInput;
        nameTbx.onfocus = nameTxbInput;
        nameTbx.onblur = () => item.querySelector(".search").classList.remove("visible");
        nameTbx.onkeydown = e => {
            let selectionElm = e.target.parentNode.querySelector(".selection");
            if (e.code == "ArrowDown") {
                if (selectedIndex == -1)
                    selectedIndex++;
                selectedIndex++;
                e.preventDefault();
            }
            if (e.code == "ArrowUp") {
                selectedIndex--;
                if (selectedIndex < 0)
                    selectedIndex = 0;
                e.preventDefault();
            }
            if (selectedIndex > -1) {
                if (selectedIndex >= selectionElm.querySelectorAll("div.item").length)
                    selectedIndex = selectionElm.querySelectorAll("div.item").length - 1;
                selectionElm.querySelectorAll("div.item").forEach(el => el.classList.remove("highlighted"));
                let selectedElm = selectionElm.querySelector("div.item:nth-child(" + (selectedIndex + 1) + ")");
                selectedElm.classList.add("highlighted");
                let height = parseInt(document.defaultView.getComputedStyle(selectedElm, '').getPropertyValue('height').substr(0, 2));
                selectionElm.scrollTop = selectedIndex * height - 150;
                if (e.code == "Enter") {
                    selectedElm.click();
                    e.preventDefault();
                }
            }
            insertHighlightedCardUI();
        }
}
on("themechanged", buildCasterList);
on("themechanged", buildHighlightedCard);

function sortable(elm, exclude, callback) {
    elm.classList.add("dragable");
    elm.onpointerdown = e => {

        let initPos = e.clientX,
            origPos = [],
            indexList = [],
            parentEl = elm.parentNode,
            downEvent = e,
            threshold = 20;

        if (exclude) {
            for (let eIdx in exclude) {
                for (let pIdx in e.path) {
                    if (parentEl.querySelector(exclude[eIdx]).outerHTML == e.path[pIdx].outerHTML) {
                        return;
                    }
                }
            }
        }

        parentEl.childNodes.forEach(childEl => origPos.push(childEl.getBoundingClientRect().x));

        elm.onmousemove = e => {
            if (Math.abs(e.x - initPos) > threshold) {
                threshold = 0;
                elm.setPointerCapture(downEvent.pointerId);
                document.body.classList.add("noPointer");
                elm.classList.add("dragging");
                indexList = [];
                parentEl.childNodes.forEach((elm, index) => indexList.push([index, elm.getBoundingClientRect().x, elm]));
                indexList.sort(function (a, b) {
                    return a[1] - b[1]
                });
                indexList.forEach((item, index) => item[2].style.transform = "translate(" + (origPos[index] - origPos[item[0]]) + "px, 0px)");
                elm.style.transform = "translate(" + (e.x - initPos) + "px,-3px)";
            }
        };
        window.onpointerup = e => {
            elm.onmousemove = null;
            document.body.classList.remove("noPointer");
            elm.releasePointerCapture(e.pointerId);
            elm.classList.remove("dragging");
            parentEl.childNodes.forEach((elm, index) => elm.style.transform = "translate(0px, 0px)");
            if (indexList.length > 1) {
                indexList.forEach((item, index) => item[2].parentNode.insertBefore(indexList[item[0]][2], item[2]));
                callback(indexList);
                window.onpointerup = null;
            }
        };
    };

}

function buildFieldList() {
    // fix fields in scoreboard.fields
    let el = document.getElementById('fields').truncate();
    _theme.fields.forEach(field => {
        let item = createElement({"type": "div", "className": "item", "append": createField(field)});
        if (field.checkbox) {
            let cbx = createElement({"type": "input", "id": "field-" + field.name + "-cbx", "className": "toggle"})
            cbx.type = "checkbox";
            cbx.onchange = e => {
                scoreboard.fields[field.name].enabled = e.target.checked;
                fire("scoreboardchanged", true);
            }
            item.appendChild(cbx);
            item.classList.add("hascheckbox");
        }
        el.appendChild(item);
    });
}

async function playerNameInput(e) {
    let txb = e.currentTarget;
    let parent = txb.closest("div.player-item");
    let {player} = parent.dataset;
    let name = txb.value;
    let players = await db.get("player", {"name": {$regex: new RegExp(`^${RegExp.escape(name)}$`, 'i')}}, {"sort": {"lastActivity": -1}});
    let po = {"name": name};

    if (players.length > 0) {
        po = players.find(x => x.name == name) || players[0];
    }

    scoreboard.players[player].player = new Player(po);
    txb.insertValue(po.name);
    parent.dataset.returnId = Math.floor(Math.random() * 1000000);
    insertPlayerUI(player)
    fire("scoreboardchanged");
}

async function deckNameInput(e) {
    let txb = e.currentTarget;
    let parent = txb.closest("div.player-item");
    let {player} = parent.dataset;
    console.log(player);
    if(!scoreboard.players[player].deck){
        scoreboard.players[player].deck = new Deck();
    }
    scoreboard.players[player].deck.name = txb.value;
    fire("scoreboardchanged");
}

async function setMatchmakingMode(value) {
    bgWork.start("matchmakingModeInput");
    scoreboard.matchformat.type = parseInt(value);
    if(scoreboard.matchformat.type == 0){
        document.getElementById("matchmaking-value").style.display = "none";
    }
    else{
        document.getElementById("matchmaking-value").style.display = null;
    }
    fire("scoreboardchanged");
    bgWork.finish("matchmakingModeInput");
}

async function setMatchmakingValue(value) {
    bgWork.start("matchmakingValueInput");
    scoreboard.matchformat.value = parseInt(value);
    fire("scoreboardchanged");
    bgWork.finish("matchmakingValueInput");
}

async function setCaster(index, co) {
    bgWork.start("setCaster");
    scoreboard.caster[index] = co;

    let casterEl = document.querySelectorAll("#caster > div")[index];
    if (casterEl) {
        let twitterbsky = co.twitter;
        if(co.bluesky != (null || '')){
            twitterbsky = co.bluesky
        }
        casterEl.querySelector(".info .name").innerText = co.name;
        casterEl.querySelector(".info .twitter").innerText = twitterbsky != (null || '') ? `@${twitterbsky}` : '';
        if (co.HasSmashgg && co.InDB || co.HasSmashgg && co.InDB) {
            let id = co.ID;
            getSmashggDifferences(co).then((res) => {
                if (scoreboard.caster[index]._id != id) {
                    return;
                } // outdated request - quit out
                casterEl.querySelector(".info .player-options .player-edit-btn").classList.toggle("outdated", res.differences.length > 0);
            });
        } else {
            casterEl.querySelector(".info .player-options .player-edit-btn").classList.remove("outdated");
        }
        casterEl.querySelector(".info .player-options .player-edit-btn").disabled = !co.InDB;

        fire("scoreboardchanged");
    }
    bgWork.finish("setCaster");
}

async function setHighlightedCard(card) {
    bgWork.start("SetHighlightedCard");
    scoreboard.highlightedCard.card = card;

    let casterEl = document.querySelectorAll("#highlighted-card > div")[0];
    if (casterEl) {
        casterEl.querySelector(".info .name").innerText = card.name ? card.name : '';
        fire("scoreboardchanged");
    }
    if(card == null || card.name == undefined){
        casterEl.querySelector(".info .name").innerText = '';
    }
    bgWork.finish("SetHighlightedCard");
}
async function changeHighlightedCardSide(side) {
    bgWork.start("changeHighlightedCardSide");
    scoreboard.highlightedCard.side = side;
    fire("scoreboardchanged");
    if(scoreboard.highlightedCard.side == "back"){
        document.getElementById("highlighted-card-back-side").classList.add("checked");
        document.getElementById("highlighted-card-front-side").classList.remove("checked");
    }else{
        document.getElementById("highlighted-card-back-side").classList.remove("checked");
        document.getElementById("highlighted-card-front-side").classList.add("checked");
    }
    bgWork.finish("changeHighlightedCardSide");
}
async function setTheme(name) {
    if (_theme && _theme.dir == name) {
        return;
    }
    bgWork.start("setTheme");
    _theme = (await ThemeWrapper.getTheme(name)) || (await ThemeWrapper.getTheme(0));
    scoreboard = correctDynamicProperties(scoreboard);
    document.getElementById('theme-select').value = _theme.dir;
    ipcRenderer.send("theme", _theme.dir);
    fire("themechanged");
    bgWork.finish("setTheme");
}

function setPlayerSize(size) {
    size = parseInt(size || 1);
    if(size < minAmountPlayers){
        size = minAmountPlayers;
    } else if(size > maxAmountPlayers){
        size = maxAmountPlayers;
    }
    document.getElementById('playersize-select').value = size;
        // decrease players to teamSize
        scoreboard.players.splice(size);
        // increase players to teamSize
        for (let i = scoreboard.players.length; i < size; i++) {
            console.log(scoreboard.players[i])
            if(!scoreboard.players[i]){
                scoreboard.players[i] = {};
            }
            scoreboard.players[i].player = new Player();
            scoreboard.players[i].deck = new Deck();
            scoreboard.players[i].score = 0;
            scoreboard.players[i].life = 0;
            scoreboard.players[i].state = 0;
        }
    buildTeamPlayerList();
}

function resetScore() {
    scoreboard.players.forEach((player, index) => {
        modifyScore(index, 0, true);
    })
}

function resetLife() {
    scoreboard.players.forEach((player, index) => {
        modifyLife(index, 20, true);
    })
}

function modifyScore(player, inc, absolute) {
    let value = parseInt(inc);
    if (!absolute)
        value += parseInt(scoreboard.players[player].score);
    if (value < 0 || isNaN(value))
        value = 0;
    scoreboard.players[player].score = value;
    document.getElementById('sb-score-val-' + player).value = value;
    fire("scoreboardchanged", true);
}

function modifyLife(player, inc, absolute) {
    let value = parseInt(inc);
    if (!absolute)
        value += parseInt(scoreboard.players[player].life);
    if (value < 0 || isNaN(value))
        value = 0;
    scoreboard.players[player].life = value;
    document.getElementById('sb-life-val-' + player).value = value;
    fire("scoreboardchanged", true);
}

function setTeamState(player, state) {
    let el = document.getElementById('sb-state-' + player);
    el.classList.toggle("winners", state == 1);
    el.classList.toggle("losers", state == 2);
    scoreboard.players[player].state = state;
    fire("scoreboardchanged", true);
}

function clearBoard() {
    for (let teamNum in scoreboard.players) {
        let team = scoreboard.players[teamNum];
        team.player = new Player();
        team.score = 0;
        team.state = 0;
    }
    scoreboard.startgg = {
        set: null,
        event: null,
        phaseGroup: null,
        phase: null
    };

    fire("scoreboardsmashggchanged");
    fire("scoreboardteamschanged");
    fire("scoreboardchanged", true);
}

function assignPlayerPort(playerNum, color) {
    const colors = ["w", "u", "b", "r", "g"];
    if(typeof scoreboard.players[playerNum].deck.colors == "undefined"){
    scoreboard.players[playerNum].deck.colors = [];}
    if(scoreboard.players[playerNum].deck.colors.includes(color)){
        // remove color if already set
        scoreboard.players[playerNum].deck.colors.splice(scoreboard.players[playerNum].deck.colors.indexOf(color), 1);
    }else{
        // add color
        scoreboard.players[playerNum].deck.colors.push(color);
    }
    colors.forEach(color => {
        let btn = document.getElementById("colorbtn-" + color + "-" + playerNum);
        if(scoreboard.players[playerNum].deck.colors.includes(color)){

            btn.classList.add("checked");
        }else{
            btn .classList.remove("checked");
        }
    })
    fire("scoreboardchanged", true);
}

function setPlayerActive(teamNum, playerNum) {
    let el = document.getElementById('sb-players-' + teamNum);
    let boxes = el.getElementsByClassName('player-select');
    for (let i in boxes) {
        boxes[i].checked = playerNum == i;
    }
    scoreboard.teams[teamNum].selected = playerNum;
    fire("scoreboardchanged", true);
    buildPlayerSeatOrder();
}

function buildPlayerSeatOrder(){
    let playerSize = scoreboard.players.length;
    scoreboard.seatorder = [];
            for (let i = 0; i < playerSize; i++) {
                    scoreboard.seatorder.push(i);
            }
    fire("scoreboardseatorderchanged");
}

function setPlayerOut(teamNum, playerNum) {
    let el = document.getElementById('sb-players-' + teamNum);
    let btn = el.querySelector('#playeritem-' + teamNum + '-' + playerNum + ' .player-out');
    let btns = el.querySelectorAll('.player-out');

    btn.classList.toggle("out");
    scoreboard.teams[teamNum].out = [].map.call(btns, x => x.classList.contains("out"));
    fire("scoreboardchanged", true);
}
async function insertPlayer(){
    scoreboard.players.forEach((po, playerNum) => insertPlayerUI(playerNum));
}

async function insertPlayerUI(playerNum) {
    let po = scoreboard.players[playerNum].player;


    let pEl = document.getElementById("playeritem-" + playerNum);

    pEl.querySelector("input.playername").insertValue(po.name);
console.log(po);
    pEl.querySelector(".player-edit-btn").disabled = !po.InDB;
    pEl.querySelector(".player-create-btn").disabled = po.name.length == 0;
    // pEl.querySelector(".smashgg-apply-btn").disabled = isNaN(parseInt(po.smashgg)) && isNaN(parseInt(po.smashggMergeable));

    pEl.querySelector(".player-edit-btn").classList.toggle("mergeable", !isNaN(parseInt(po.smashggMergeable)) && (parseInt(po.smashgg) == 0 || isNaN(parseInt(po.smashgg))));
    pEl.querySelector(".player-create-btn").classList.toggle("new", !isNaN(parseInt(po.smashgg)) && !po.InDB);

    getSmashggDifferences(po).then((res) => {
        if (po._id != res.player._id) {
            return;
        } // check if still same player
        pEl.querySelector(".player-edit-btn").classList.toggle("outdated", res.differences.length > 0);
    });

    let country;
    country = APPRES + '/assets/country/' + po.country + '.png';
    if (fs.existsSync(APPRES + '/assets/country/' + po.country + '.png')) {
        country = APPRES + '/assets/country/' + po.country + '.png';
    } else {
        country = APPRES + '/assets/country/' + po.country + '.svg';
    }
    console.log(country);
    if (po.InDB) {
        db.get("team", {$or: [].concat(po.team).map(x => ({"_id": x}))}).then(entry => {
            let value = entry.map(x => x.name).join(", ");
            pEl.querySelector(".team").innerText = value;
            pEl.classList.toggle("hasteam", value.length > 0);
        });
        db.count("player", {"name": {$regex: new RegExp(`^${RegExp.escape(po.name)}$`, 'i')}})
            .then(count => pEl.getElementsByClassName("player-multi-btn")[0].disabled = count <= 1);
        pEl.querySelector('.country').style.backgroundImage = `url('${country}')`;
    } else {
        pEl.querySelector(".team").innerText = "";
        pEl.classList.remove("hasteam");
        pEl.querySelector(".player-multi-btn").disabled = true;
        pEl.querySelector(".country").style.backgroundImage = "";
    }
}


function playerChangedHandler(docs) {
    for (let teamNum in scoreboard.teams) {
        for (let playerNum in scoreboard.teams[teamNum].players) {
            let po = scoreboard.teams[teamNum].players[playerNum];
            let txb = document.querySelector("#playeritem-" + teamNum + "-" + playerNum + " input.playername");
            docs.forEach((doc) => {
                if (doc.name == txb.value || doc._id == po._id) {
                    txb.dispatchEvent(new Event('input'));
                }
            });
        }
    }

    let oldIds = scoreboard.caster.map(x => x._id);
    let newIds = docs.map(x => x._id);
    let affected = oldIds.filter(value => newIds.includes(value));
    if (affected.length >= 0) {
        affected.forEach((pId) => scoreboard.caster[oldIds.indexOf(pId)] = new Player(docs[newIds.indexOf(pId)]));
        fire("scoreboardcasterchanged");
    }
}

function insertCasterUI() {
    scoreboard.caster.forEach((caster, idx) => setCaster(idx, caster));
}
function insertHighlightedCardUI() {
    let casterEl = document.querySelectorAll("#highlighted-card > div")[0];
    if (casterEl && scoreboard.highlightedCard.card) {
        casterEl.querySelector(".info .name").innerText = scoreboard.highlightedCard.card.name;
    }
    if(scoreboard.highlightedCard.card == null || scoreboard.highlightedCard.card.name == undefined){
        casterEl.querySelector(".info .name").innerText = '';
    }
    if(scoreboard.highlightedCard.side == "back"){
        document.getElementById("highlighted-card-back-side").classList.add("checked");
        document.getElementById("highlighted-card-front-side").classList.remove("checked");
    }else{
        document.getElementById("highlighted-card-back-side").classList.remove("checked");
        document.getElementById("highlighted-card-front-side").classList.add("checked");
    }
}

function insertScoreboardData(newScoreboard) {

    if (newScoreboard) {
        scoreboard = correctDynamicProperties(newScoreboard);
    }

    // Fix player object Instances
    for (let teamNum in scoreboard.teams) {
        scoreboard.teams[teamNum].players = scoreboard.teams[teamNum].players.map((po) => (po instanceof Player ? po : new Player(po)));
    }

    // Fix caster object instances
    scoreboard.caster = scoreboard.caster.map((caster) => (caster instanceof Player ? caster : new Player(caster)));

    for (let fieldName in scoreboard.fields) {
        document.getElementById("field-" + fieldName).value = scoreboard.fields[fieldName].value;
        let cbx = document.getElementById("field-" + fieldName + "-cbx");
        if (cbx) {
            cbx.checked = scoreboard.fields[fieldName].enabled;
        }
    }

    // insert ports
        for (let playerNum = 0; playerNum < scoreboard.players.length; playerNum++) {
            // for (let portNum = 1; portNum <= portAmount; portNum++) {
            //     let hasPort = scoreboard.ports[portNum] != null && scoreboard.ports[portNum][0] == teamNum && scoreboard.ports[portNum][1] == playerNum;
            //     document.getElementById("playerport-" + portNum + "-" + teamNum + "-" + playerNum).classList.toggle("checked", hasPort);
            // }
        }
    var matchmakingValue = document.getElementById("matchmaking-value");
    matchmakingValue.value = scoreboard.matchformat.value;
    var matchmakingMode = document.getElementById("matchmaking-mode");
    matchmakingMode.value = scoreboard.matchformat.type;
    if(scoreboard.matchformat.type === 0){
        matchmakingValue.style.display = "none";
    }else{
        matchmakingValue.style.display = null;
    }
    insertHighlightedCardUI();
    fire("scoreboardsmashggchanged");
    fire("scoreboardcasterchanged");
    fire("scoreboardteamschanged");
    fire("scoreboardchanged", true);
}

function correctDynamicProperties(data) {

    // gracefully remove unneeded fields from scoreboard
    for (let fieldName in data.fields) {
        let del = true;
        _theme.fields.forEach(field => del = (fieldName == field.name ? false : del));
        if (del)
            delete data.fields[fieldName];
    }
    // add missing fields to scoreboard
    _theme.fields.forEach(field => {
        if (!data.fields.hasOwnProperty(field.name))
            data.fields[field.name] = {value: "", enabled: !field.checkbox};
    });
    return data;
}

function toggleSeatorderGlue() {
    document.getElementById('seatorder-glue-option').classList.toggle("enabled");
    // buildSeatOrder();
}

function buildSeatOrder(affectedSeat) {
    let el = document.getElementById('seatorder').truncate();
    el.classList.toggle("visible", scoreboard.seatorder.length > 0);
    let glueTeams = document.getElementById('seatorder-glue-option').classList.contains("enabled");
    if (glueTeams) {
        let first = scoreboard.seatorder[0][0];
        if (affectedSeat != undefined) {
            // check if affected seat is last index
            for (let idx in scoreboard.seatorder) {
                if (scoreboard.seatorder[idx][0] == affectedSeat[0] && scoreboard.seatorder[idx][1] == affectedSeat[1] && idx == scoreboard.seatorder.length - 1) {
                    first = (affectedSeat[0] == 1 ? 2 : 1);
                    break;
                }
            }
        }
        // reorder teams together
        let teams = {1: [], 2: []};
        scoreboard.seatorder.forEach((entry) => teams[entry[0]].push(entry));
        scoreboard.seatorder = teams[first].concat(teams[(first == 1 ? 2 : 1)]);
    }

    scoreboard.seatorder.forEach((seat, index) => {
        let item = document.createElement("div");
        let po = scoreboard.players[seat];
        item.innerText = po.player.name || ((seat + 1) + ". Player");
        item.classList.toggle("hasname", po.player.name !== undefined && po.player.name.length > 0);
        item.classList.add("team" + seat);
        sortable(item, null, (indexList) => {
            scoreboard.seatorder = indexList.map((x) => scoreboard.seatorder[x[0]]);
            fire("scoreboardseatorderchanged", seat);
            fire("scoreboardchanged", true);
        });
        el.appendChild(item);
    });
}

async function editPlayer(arg) {
    let po, returnId, parentEl;

    if (arg instanceof Event) {
        parentEl = arg.currentTarget.closest("div.player-item");
        let {player} = parentEl.dataset;
        returnId = Math.floor(Math.random() * 100000);
        parentEl.dataset.returnId = returnId;
        po = scoreboard.players[player].player;

        if (arg.currentTarget.classList.contains("player-create-btn")) {
            po._id = "";
        }

    } else if (arg) {
        po = arg;
    }

    let res = await openWindow("database-entry", {db: "player", entry: new Player(po)});

    if (parentEl && parseInt(parentEl.dataset.returnId) == returnId) {
        console.log("edit player res:", res);
    }

}

async function buildPlayerAutoCompleteList() {
    bgWork.start("buildPlayerAutoCompleteList");
    let players = await db.get("player");
    let frag = document.createDocumentFragment();
    let namesAdded = [];
    players.forEach((p) => {
        if (!namesAdded.includes(p.name)) {
            let opt = document.createElement("option"); // do NOT optimize with "createElement()", performance important here
            opt.value = p.name;
            frag.appendChild(opt);
            namesAdded.push(p.name);
            let country;
            country = APPRES + '/assets/country/' + p.country + '.png';
            if (fs.existsSync(APPRES + '/assets/country/' + p.country + '.png')) {
                country = APPRES + '/assets/country/' + p.country + '.png';
            } else {
                country = APPRES + '/assets/country/' + p.country + '.svg';
            }
            opt.style.backgroundImage = `url('${country}')`;
            opt.style.backgroundSize = "contain";
            opt.style.backgroundRepeat = "no-repeat";
            opt.style.backgroundPosition = "right";
        }
    });
    document.getElementById('playernames').truncate().appendChild(frag);
    bgWork.finish("buildPlayerAutoCompleteList");
    if(_ws != undefined) {
        _ws.send("playersList", players);
    }
}
async function buildCardAutoCompleteList() {
    bgWork.start("buildCardAutoCompleteList");
    let cards = await db.get("card", {}, {sort: {"name": 1}});
    let frag = document.createDocumentFragment();
    cards.forEach((c) => {
        let opt = document.createElement("option"); // do NOT optimize with "createElement()", performance important here
        opt.value = c.name;
        frag.appendChild(opt);
    });
    document.getElementById('cardnames').truncate().appendChild(frag);
    bgWork.finish("buildCardAutoCompleteList");
}

async function buildThemeSelection() {
    let el = document.getElementById('theme-select').truncate();
    let themes = await ThemeWrapper.getThemesList();
    themes.forEach((theme) => {
        let opt = document.createElement("option");
        opt.value = theme.dir;
        opt.innerText = theme.Name + (themes.some(x => x.name == theme.name && x.dir != theme.dir) ? " (" + theme.dir + ")" : "");
        opt.selected = _theme.dir == theme.dir;
        el.appendChild(opt);
    });
}

function createField(field) {
    let tpl = document.getElementById("fields-" + field.type + "-tpl") || document.getElementById("fields-text-tpl");
    let el = createElement({"type": "div", "className": "field-" + field.type});
    let label = createElement({"type": "div", "className": "label"});
    label.innerText = field.label;

    el.appendChild(label);
    el.appendChild(tpl.content.cloneNode(true));
    let inputElm = el.getElementsByClassName("ref")[0];

    switch (field.type) {
        case "time":
            el.getElementsByTagName("button")[0].onclick = (e) => {
                let now = new Date();
                let refEl = el.getElementsByTagName("input")[0];
                let offsetHourEl = el.getElementsByClassName("field-time-offset")[0].getElementsByTagName("input")[0];
                let offsetMinuteEl = el.getElementsByClassName("field-time-offset")[0].getElementsByTagName("input")[1];
                now.setTime(now.getTime() + offsetHourEl.value * 3600000 + offsetMinuteEl.value * 60000);
                refEl.value = now.toTimeString().substr(0, 5);
                offsetHourEl.value = 0;
                offsetMinuteEl.value = 0;
                refEl.dispatchEvent(new Event('input'));
            };
            break;
        case "dropdown":
            let options = field.options || ["(No options available)"];
            inputElm.truncate();
            options.forEach((opt) => {
                let optEl = document.createElement("option");
                optEl.value = opt;
                optEl.innerText = opt;
                inputElm.appendChild(optEl);
            });
        case "scenes":
            if(field.multiple){
                inputElm.setAttribute('multiple', '1')
                inputElm.setAttribute('size', '1')
            }
            break;
    }

    inputElm.id = "field-" + field.name;
    inputElm.addEventListener("input", (e) => {
        if(e.target.multiple){
            scoreboard.fields[field.name].value = Array.from(e.target.selectedOptions).map(x => x.value);
        }else {
            scoreboard.fields[field.name].value = e.target.value;
        }
        fire("scoreboardchanged");
    });

    return el;
}

function toggleAutoUpdate(value) {
    client.autoupdate = (value != null ? value : !client.autoupdate);
    ipcRenderer.invoke("set", "autoupdate", client.autoupdate);
    document.getElementById('autoupdate-cbx').checked = client.autoupdate;
}

function autoUpdate(noThreshold) {
    noThreshold = (noThreshold == null ? false : noThreshold);
    if (!client.autoupdate) {
        return;
    }
    if (_timeouts.hasOwnProperty("autoupdate")) {
        clearTimeout(_timeouts.autoupdate);
    }
    _timeouts.autoupdate = setTimeout(update, noThreshold ? 5 : client.autoupdateThreshold);
}

async function update() {
    let now = new Date();
    scoreboard._D = now;

    // apply last stream activity for each player on stream
        db.update("player", {$or: scoreboard.players.map((x) => ({"_id": x.player._id}))}, {"lastActivity": now}, true);

    let dbEntries = await collectDatabaseEntries(scoreboard);
    if (scoreboard._D != now) {
        return;
    } // prevent multiple updates due to delay
    _ws.send("scoreboard", {scoreboard, dbEntries});
    insertMatchList(scoreboard);
    fs.writeFileSync(path.join(path.join(remote.app.getPath('userData'),'scoreboard.json')), JSON.stringify(scoreboard)); // legacy - reads startup data
    fire("update");
}

function obsUpdate(name, stats) {
    _ws.send('obs' + name, {stats});
}

function streamqueuechanged(value) {
    // console.log(scoreboard.streamlist);
    // console.log('streamqueue changed')
    // console.log(streamQueue);
    _ws.send('streamQueue', streamQueue);
}

async function collectDatabaseEntries(sb) {
    let dbData = {country: [], team: [], pride: []};
        sb.players.forEach((player) => {
            dbData.country.push(player.player.country);
            dbData.pride = dbData.pride.concat(player.player.pride);
            dbData.team = dbData.team.concat(player.player.team);
        });

    sb.caster.forEach((caster) => { // insert DB fetch IDs for caster
        dbData.country.push(caster.country);
        dbData.pride = dbData.pride.concat(caster.pride);
        dbData.team = dbData.team.concat(caster.team);
    });

    for (let dbName in dbData) {
        // filter out empty values
        dbData[dbName] = dbData[dbName].filter((x) => x != null && x.length > 0);

        // convert VALUE to {"_id": VALUE} for all object childs
        dbData[dbName] = dbData[dbName].map((x) => ({"_id": x}));

        // create promise for DB fetch
        dbData[dbName] = await db.get(dbName, {$or: dbData[dbName]});
    }
    return dbData;
}

async function insertMatchList(sb) {
    if (sb.id == null) {
        await newMatch(true);
    }
    let data = await db.getSingle('match', {"_id": sb.id});
    if (data == null) {
        return;
    } // fail safe
    let entry = Object.assign(data, {
        players: sb.players,
        type: sb.type,
        smashgg: sb.smashgg,
        _D: new Date()
    });

        sb.players.forEach((player, playerNum) => {
            entry.players[playerNum].player = player.player
        });

    // add commentators
    sb.caster.forEach((caster) => {
        if (caster.name.length == 0) {
            return;
        }
        for (let i in entry.caster) {
            if (entry.caster[i]._id.length > 0 && entry.caster[i]._id == caster._id) {
                return;
            }
            if (entry.caster[i]._id.length == 0 && entry.caster[i].name == caster.name) {
                return;
            }
        }
        entry.caster.push({"_id": caster._id, "name": caster.name});
    });

    // overwrite fields
    _theme.fields.forEach((field) => {
        if (field.matchlist) {
            entry.fields[field.name] = sb.fields[field.name].value;
        }
    });

    db.update("match", {"_id": entry._id}, entry);
}

async function newMatch(noClear) {
    await db.add("match", {"teams": [], "caster": [], "fields": {}, "_D": new Date()});
    if (noClear != true) {
        clearBoard();
    }
    applyLastMatchId();
}

async function applyLastMatchId() {
    scoreboard.id = await getLastMatchId();
}

async function getLastMatchId() {
    let matches = await db.get("match", null, null, {sort: {"_D": -1}, limit: 1});
    if (matches.length == 0) {
        return;
    }
    return matches[0]._id;
}

function clockUpdate() {
    let d = new Date();
    let h = d.getHours();
    let i = d.getMinutes();
    i = (i < 10 ? '0' : '') + i;
    h = (h < 10 ? '0' : '') + h;
    let offset = -d.getTimezoneOffset();
    document.getElementById('clock').firstElementChild.innerText = h + ':' + i;
    document.getElementById('clock').lastElementChild.innerText = "UTC " + (offset >= 0 ? "+" : "-") + parseInt(offset / 60) + (offset % 60 == 0 ? "" : ":" + offset % 60);
    setTimeout(clockUpdate, (60 - d.getSeconds()) * 1000);
}


function handleWsCommand(data) {
    switch (data.name) {
        case "score":
            modifyScore(data.player, data.value, data.absolute);
            break;
        case "clear":
            clearBoard();
            break;
        case "update":
            update();
            break;
        case "smashgg-next":
            smashggApplyNextSet();
            break;
    }
}


function on(name, fn) {
    if (!_callbacks.on.hasOwnProperty(name))
        _callbacks.on[name] = [];
    _callbacks.on[name].push(fn);
}

function once(name, fn) {
    if (!_callbacks.once.hasOwnProperty(name))
        _callbacks.once[name] = [];
    _callbacks.once[name].push(fn);
}

function fire(name, data) {
    if (_callbacks.hold.indexOf(name) > -1)
        return false;
    if (_callbacks.on.hasOwnProperty(name))
        _callbacks.on[name].forEach(cb => cb(data));
    if (_callbacks.once.hasOwnProperty(name)) {
        _callbacks.once[name].forEach(cb => cb(data));
        _callbacks.once[name] = [];
    }
}

function hold(name) {
    if (_callbacks.hold.indexOf(name) === -1)
        _callbacks.hold.push(name);
}

function release(name) {
    let index = _callbacks.hold.indexOf(name);
    if (index > -1)
        _callbacks.hold.splice(index, 1);
}

var bgWork = {
    workers: [],
    start: function (name) {
        if (this.workers.indexOf(name) == -1)
            this.workers.push(name);
        this.check();
    },
    finish: function (name) {
        let index = this.workers.indexOf(name);
        if (index > -1)
            this.workers.splice(index, 1);
        this.check();
    },
    finishAll: function () {
        this.workers = [];
        this.check();
    },
    check: function () {
        document.body.classList.toggle("working", this.workers.length > 0);
    }
}

function showObs(value) {
    if (value) {
        document.querySelectorAll('.obsbtn-div').forEach(e => e.classList.remove('hide'));
    } else {
        document.querySelectorAll('.obsbtn-div').forEach(e => e.classList.add('hide'));
    }
}

ipcRenderer.on('obsSceneChanged', (event, name) => {
    obs.currentScene = name;
    obsUpdate('SceneChanged', obs);
});


function startObs() {
    ipcRenderer.send("obs", "start");
}

function stopObs() {
    ipcRenderer.send("obs", "stop");
}

ipcRenderer.on("obs_status", (event, name) => {
    switch (name) {
        case "disconnected":
            document.getElementById("start-obs-btn").disabled = false;
            document.getElementById("start-obs-btn").style.display = 'inherit';
            document.getElementById('stop-obs-btn').style.display = 'none';
            document.getElementById("obs-status").innerHTML = 'Disconnected to OBS';
            break;
        case "connected":
            document.getElementById("start-obs-btn").disabled = true;
            document.getElementById("start-obs-btn").style.display = 'none';
            document.getElementById("stop-obs-btn").style.display = 'inherit';
            document.getElementById("obs-status").innerHTML = 'Connected to OBS';
            break;
        case 'connecting':
            document.getElementById("start-obs-btn").disabled = true;
            document.getElementById("start-obs-btn").style.display = 'none';
            document.getElementById("stop-obs-btn").style.display = 'inherit';
            document.getElementById("obs-status").innerHTML = 'Connecting to OBS';
            break;
        case 'reconnecting':
            document.getElementById("start-obs-btn").disabled = true;
            document.getElementById("start-obs-btn").style.display = 'none';
            document.getElementById("stop-obs-btn").style.display = 'inherit';
            document.getElementById("obs-status").innerHTML = 'Reconnecting to OBS';
            break;
    }
});

ipcRenderer.on('obsCurrentSceneChanged', (event, name) => {
    console.log('obsCurrentSceneChanged');
    ipcRenderer.invoke("set", "obsCurrentScene", name);
    applyClientSettings([{name: 'obsCurrentScene', value: name}]);
});

ipcRenderer.on('obsSceneListChanged', (event, list) => {
    console.log('obsSceneListChanged');
    ipcRenderer.invoke("set", "obsSceneList", list);
    applyClientSettings([{name: 'obsSceneList', value: list}]);
});

function casterAdd() {
    _theme.caster++;
    buildCasterList();

}

function casterDelete() {
    if (_theme.caster > 1) {
        _theme.caster--;
        buildCasterList();
    }

}
async function openStreamQueueOptions(){
    let windowSettings = await openWindow("streamqueue-settings", {
        "tournamentSlug": usedTournamentWebsite == "smashgg" ? smashgg.selectedTournament : '',
        "streamId": usedTournamentWebsite == "smashgg" ? smashgg.selectedStream : '',
        "smashgg-cache": smashgg.cache,
        "smashgg-token": smashgg.token,
        "tournamentWebsite": usedTournamentWebsite
    }, true);
    if (!windowSettings) { return; }
    usedTournamentWebsite = windowSettings.tournamentWebsite;
    ipcRenderer.invoke("set", "tournamentWebsite", usedTournamentWebsite);
        switch (usedTournamentWebsite) {
        case "smashgg":
            applySmashggSettings(windowSettings.tournamentSlug, windowSettings.streamId);
            ipcRenderer.invoke('set', 'smashgg', { "tournament": windowSettings.tournamentSlug, "stream": windowSettings.streamId });
            break;
    }
}