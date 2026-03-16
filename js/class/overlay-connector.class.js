class OverlayConnector {
    constructor(name, requests) {
        this.address = location.hostname;
        this.port = location.port;
        this.id = Date.now().toString(32) + Math.ceil(Math.random() * 1000).toString(32);
        this.name = name || this.id;
        this.ws = null;
        this._callbacks = {on: {}, once: {}, any: []};
        this.debug = false;
        this.debugTimeout;
        this.messageIdCounter = 1;
        this.awaitingCommandReturns = {};
        this.requests = requests || ["scoreboard"];
        this.subscriptions = this.requests || [];

        this.cache = {
            scoreboard: {},
            team: {},
            country: {},
            pride: {},
            obs: {},
            streamQueue: []
        };

        // this.on("theme", e => location.reload());

        this.init();
        document.onreadystatechange = (e) => this.init();
    }

    static MATCHFORMAT_TYPE = {
        FREEPLAY: 0,
        BESTOF: 1,

        0: "FREEPLAY",
        1: "BESTOF"
    }

    init() {
        if (document.readyState != "complete") return;
        this.connect();
        this.sourceVisibleBind(this.name);
    }

    connect() {
        this.ws = new WSWrapper(this.address, this.port, true);
        this.ws.on("data", data => {
            if (data.hasOwnProperty("type") && data.hasOwnProperty("data")) {
                data = this.processdata(data);
                this.fire(data.type, data.data);
            }
        });
        this.ws.on("open", () => {
            this.register();
            this.subscriptions.forEach(subName => this.ws.send({"type": "subscribe", "data": subName}));
            if (!Array.isArray(this.requests))
                this.requests = [this.requests];
            this.requests.forEach(req => this.request(req));
            this.fire("ready");
        });
    }

    register() {
        this.ws.send({"type": "register", "data": {"id": this.id, "name": this.name, "filename": __FILENAME__}});
    }

    request(name) {
        this.ws.send({"type": "request", "data": name});
    }

    subscribe(name) {
        this.subscriptions.push(name);
        if (this.ws && this.ws.Open) {
            this.ws.send({"type": "subscribe", "data": name});
        }
    }

    command(module, args, cb) {
        let mid = this.messageIdCounter++;
        if (cb && typeof cb == "function") {
            this.awaitingCommandReturns[module + "-cmd-return-" + mid] = cb;
        }
        this.ws.send({"type": module + "-cmd", "data": args, "mid": mid});
    }

    processdata(data) {
        console.log(data);
        switch (data.type) {
            case 'scoreboard':
                let sb = data.data.scoreboard;
                let db = data.data.dbEntries;
                this.cache.scoreboard = sb;
                for (let teamNum in sb.teams) {
                    sb.teams[teamNum].players = this.assignPrototype(sb.teams[teamNum].players, Player);
                }
                sb.caster = this.assignPrototype(sb.caster, Player);
                for (let dbIndex in db) {
                    for (let entryIndex in db[dbIndex]) {
                        this.cache[dbIndex][db[dbIndex][entryIndex]._id] = db[dbIndex][entryIndex];
                    }
                }
                data.data = sb;
                break;
            case 'obsSceneChanged':
                this.cache.obs.activeScene = data.data;
                break;
            case 'obsSceneList':
                this.cache.obs.sceneList = data.data;
                break;
            case 'streamQueue':
                this.cache.streamQueue = data.data;
                break;
        }


        if (data.mid !== null) {
            for (let i in this.awaitingCommandReturns) {
                if (data.type + "-" + data.mid == i) {
                    this.awaitingCommandReturns[i](data.data);
                    delete this.awaitingCommandReturns[i];
                    break;
                }
            }
        }

        return data;
    }

    /**
     * Get player object
     * @param teamNum
     * @param playerNum
     * @returns {*|null}
     */
    getPlayer(playerNum) {

        if (this.cache.scoreboard.players.hasOwnProperty(playerNum))
            return this.cache.scoreboard.players[playerNum].player;
        return null;
    }

    getScore(playerNum) {
        if (this.cache.scoreboard.players.hasOwnProperty(playerNum))
            return this.cache.scoreboard.players[playerNum].score;
        return null;
    }

    getCountry(playerNum) {
        let po = this.getPlayer(playerNum);
        if (po && this.cache.country.hasOwnProperty(po.country))
            return this.cache.country[po.country];
        return null;
    }

    getPride(playerNum) {
        let po = this.getPlayer(playerNum);
        let po2 = this.cache.pride;
        po2 = Object.keys(po2)
            .filter(key => po.pride.includes(key))
            .reduce((obj, key) => {
                obj[key] = po2[key];
                return obj;
            }, {});
        return Object.values(po2);
    }

    getPlayerTeams(playerNum) {
        let po, teams = [];
        if (teamNum instanceof Player) {
            po = teamNum;
        } else {
            playerNum = playerNum || 0;
            po = this.getPlayer(playerNum);
        }
        if (po == null) {
            return [];
        }
        po.team.forEach(teamID => {
            if (this.cache.team.hasOwnProperty(teamID))
                teams.push(this.cache.team[teamID]);
        });
        return teams;
    }

    getCaster(casterNum) {
        if (this.cache.scoreboard.caster.hasOwnProperty(casterNum - 1))
            return this.cache.scoreboard.caster[casterNum - 1];
        return null;
    }

    getCasterCountry(casterNum) {
        let po = this.getCaster(casterNum);
        if (po && this.cache.country.hasOwnProperty(po.country))
            return this.cache.country[po.country];
        return null;
    }

    getCasterPride(casterNum) {
        let po = this.getCaster(casterNum);
        let po2 = this.cache.pride;
        po2 = Object.keys(po2)
            .filter(key => po.pride.includes(key))
            .reduce((obj, key) => {
                obj[key] = po2[key];
                return obj;
            }, {});
        return Object.values(po2);
    }

    getField(name) {
        try {
            return this.cache.scoreboard.fields[name];
        } catch (e) {
            return {value: "", enabled: false};
        }
    }

    getFieldValue(name) {
        let field = this.getField(name);
        return field.value;
    }

    get TeamSize() {
        return Math.max(this.cache.scoreboard.teams[1].players.length, this.cache.scoreboard.teams[2].players.length);
    }

    assignPrototype(docs, proto) {
        for (let i in docs) {
            if (proto.length == 1)
                docs[i] = new proto(docs[i]);
            else
                docs[i].__proto__ = proto.prototype;
        }
        return docs;
    }

    resolve(dbName, id) {
        return this.cache[dbName][id];
    }


    sourceVisibleBind(arg) {

        if (typeof arg == "string") {
            arg = {"source": arg};
        }
        let params = {
            "source": arg.source || "",
            "element": arg.element || document.body,
            "visibleClass": arg.visibleClass || "visible",
            "hiddenClass": arg.hiddenClass || "hidden",
            "default": arg.default || true
        };

        params.element.classList.toggle(params.visibleClass, params.default);
        params.element.classList.toggle(params.hiddenClass, !params.default);

        this.subscribe("overlay-trigger");
        this.on("overlay-trigger", (data) => {
            if (data.source != params.source || !params.element) {
                return;
            }
            if (data.visible == null) {
                data.visible = params.element.classList.contains(params.hiddenClass);
            }
            params.element.classList.toggle(params.visibleClass, data.visible);
            params.element.classList.toggle(params.hiddenClass, !data.visible);
        });
    }

    on(name, callback) {
        if (!this._callbacks.on.hasOwnProperty(name)) {
            this._callbacks.on[name] = [];
        }
        this._callbacks.on[name].push(callback);
    }

    once(name, callback) {
        if (!this._callbacks.once.hasOwnProperty(name)) {
            this._callbacks.once[name] = [];
        }
        this._callbacks.once[name].push(callback);
    }

    fire(name, data) {
        if (this._callbacks.on.hasOwnProperty(name)) {
            this._callbacks.on[name].forEach(cb => cb(data));
        }
        if (this._callbacks.once.hasOwnProperty(name)) {
            this._callbacks.once[name].forEach(cb => cb(data));
            this._callbacks.once[name] = [];
        }
    }

    async getPlayersByStartGGId(startGGId) {
        if (this.ws && this.ws.Open) {
            let randomId = Math.random().toString(36).substring(2, 15);
            this.ws.send({"type": "getPlayersByStartGGId", "data": {data: startGGId, 'id': this.id, 'mid': randomId}});
            this.ws.once("getPlayersByStartGGId-" + randomId, (data) => {
                console.log(data);
                return data;
            })
        }
    }

    getPictureUrl(url) {
        if (url) {
            let urlSVG = url + '.svg';
            let req = new XMLHttpRequest();
            req.open('GET', urlSVG, false);
            req.send();
            if (req.status == 200) {
                return urlSVG;
            }
            let urlPNG = url + '.png';
            req = new XMLHttpRequest();
            req.open('GET', urlPNG, false);
            req.send();
            if (req.status == 200) {
                return urlPNG;
            }
			let urlGIF = url + '.gif';
			req = new XMLHttpRequest();
			req.open('GET', urlGIF, false);
			req.send();
			if (req.status == 200) {
				return urlGIF;
			}
			let urlJPG = url + '.jpg';
			req = new XMLHttpRequest();
			req.open('GET', urlJPG, false);
			req.send();
			if (req.status == 200) {
				return urlJPG;
			}
			let urlJPEG = url + '.jpeg';
			req = new XMLHttpRequest();
			req.open('GET', urlJPEG, false);
			req.send();
			if (req.status == 200) {
				return urlJPEG;
			}
        }
        return false;
    }
}