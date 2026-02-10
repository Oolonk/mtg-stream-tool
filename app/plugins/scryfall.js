const EventEmitter = require('events');
const fs = require("fs");
const fsPromises = fs.promises;
const {APP} = require("../electron");
var events = new EventEmitter();
function Scryfall() {
    this.lastCreated = null;
    this.isRunning = false;
    this._callbacks = {on: {}, once: {}, any: []};
    this.event = new EventEmitter();
    this.base_url = 'https://api.scryfall.com';
    this.header = {
        'Content-Type': 'application/json',
        "Accept"       : "application/json",
        "User-Agent"   : `MTG Stream Overlay`
    }
    this.nedb = null;
}
Scryfall.prototype.getBulkData = async function getBulkData(lastCreated = null) {
    try {
        this.event.emit('fetchingBulkData', { lastCreated });
        const responseBulks = await fetch(`${this.base_url}/bulk-data`, {
            method: 'GET',
            headers: this.header
        });
        if (!responseBulks.ok) throw new Error(`Failed to fetch bulk-data: ${responseBulks.status} ${responseBulks.statusText}`);
        var data = {};
        const bulkJson = await responseBulks.json();
        const bulkData = Array.isArray(bulkJson.data) ? bulkJson.data : [];

        const oracle = bulkData.find((bulk) => bulk.type === 'oracle_cards');
        data.oracle = oracle;
        if (!oracle) {
            // No oracle_cards bulk found
            return null;
        }
        var lastUpdated = new Date(oracle.updated_at);
        if (lastCreated != null) {
            var lastCreatedDate = new Date(lastCreated);
            if (lastCreatedDate >= lastUpdated) {
                // No update needed
                return null;
            }
        }

        const downloadResp = await fetch(oracle.download_uri, {
            method: 'GET',
            headers: this.header
        });
        if (!downloadResp.ok) throw new Error(`Failed to download oracle_cards: ${downloadResp.status} ${downloadResp.statusText}`);

        data.cards = await downloadResp.json();
        return data;
    } catch (err) {
        console.error('Scryfall.getBulkData error:', err);
        throw err;
    }
};

Scryfall.prototype.insertBulkData = async function insertBulkData(data) {
    if (!data || !data.cards) {
        console.warn('No data to insert into database');
        return;
    }
    const db = this.nedb;
    var cards = data.cards;

    // small helper to promisify NeDB-style callbacks
    const promisifyDb = (fn, ...args) => {
        return new Promise((resolve, reject) => {
            try {
                fn(...args, (err, res) => {
                    if (err) return reject(err);
                    resolve(res);
                });
            } catch (e) {
                reject(e);
            }
        });
    };

    for (let i = 0; i < cards.length; i++){
        const card = cards[i];
        const current = i + 1;
        this.event.emit('insertingCard', { current: current, total: cards.length });
        if (card.layout === "art_series" || card.layout === "token" || card.layout === "emblem" || card.layout === "vanguard" || card.layout === "double_faced_token" || card.layout === "planar") {
            continue;
        }

        card._id = card.id;
        let doc = null;
        try {
            // wait for findOne to complete
            doc = await promisifyDb(db.findOne.bind(db), { _id: card._id });
        } catch (err) {
            console.error('Error checking for existing card in database:', err);
        }

        let updateImages = true;
        if (!doc) {
            try {
                await promisifyDb(db.insert.bind(db), card);
            } catch (err) {
                console.error('Error inserting card into database:', err);
            }
        } else {
            if (doc.image_status == 'highres_scan' || doc.images_status == card.image_status) {
                if (fs.existsSync(`${APPRES}/assets/card/front/${card._id}.png`)){
                    updateImages = false;
                }
            }
            try {
                await promisifyDb(db.update.bind(db), {_id: card._id}, card, {});
            } catch (err) {
                console.error('Error updating card in database:', err);
            }
        }

        if (updateImages) {
            // wait until images are downloaded and written to disk
            try {
                await this.downloadCardImages(card);
            } catch (e) {
                console.error('downloadCardImages failed for', card.id, e);
            }
        }
    }
};

Scryfall.prototype.updateCards = async function updateCards() {
    try {
        const bulkData = await this.getBulkData(this.lastCreated);
        if (bulkData) {
            await this.insertBulkData(bulkData);
            this.lastCreated = bulkData.oracle.updated_at;
            console.log("Scryfall data updated successfully.");
            await this.event.emit('updateFinished', bulkData.oracle.updated_at);
            return;
        }else{
            console.log("Scryfall data is up to date, no update needed.");
            await this.event.emit('noUpdateNeeded');
            return;
        }
    } catch (e){
        console.error('Error updating Scryfall cards:', e);
    }
}

Scryfall.prototype.downloadCardImages = async function downloadCardImages(card) {
    try{
        // ensure APPRES exists -- fallback to APP if available

        if (card.image_uris && card.image_uris.png){
            const imageUrl = card.image_uris.png;
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error(`Failed fetching image: ${response.status} ${response.statusText}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await fsPromises.writeFile(`${APPRES}/assets/card/front/${card.id}.png`, buffer);
            return;
        }

        switch(card.layout){
            case 'flip':
            case 'transform':
            case 'modal_dfc':
            case 'meld': {
                const resp1 = await fetch(card.card_faces[0].image_uris.png);
                if (!resp1.ok) throw new Error(`Failed fetching image face 1: ${resp1.status}`);
                const buf1 = Buffer.from(await resp1.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/front/${card.id}.png`, buf1);

                const resp2 = await fetch(card.card_faces[1].image_uris.png);
                if (!resp2.ok) throw new Error(`Failed fetching image face 2: ${resp2.status}`);
                const buf2 = Buffer.from(await resp2.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/back/${card.id}.png`, buf2);
                return;
            }
            default: {
                // fallback to first face
                const resp = await fetch(card.card_faces && card.card_faces[0] ? card.card_faces[0].image_uris.png : null);
                if (!resp || !resp.ok) throw new Error('No image available for card');
                const buf = Buffer.from(await resp.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/front/${card._id || card.id}.png`, buf);
                return;
            }
        }
    } catch (e){
        console.log(`Error downloading images for card ${card.name} (${card.id}), retrying...`, e);
        // exponential backoff/retry could be used; keep simple retry after delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.downloadCardImages(card);
    }
}

Scryfall.prototype.on = function on(...args) {
    this.event.on(...args);
}
module.exports = Scryfall;

