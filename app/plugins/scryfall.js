const EventEmitter = require('events');
const fs = require("fs");
const fsPromises = fs.promises;
const zlib = require("zlib");
const {Readable} = require("stream");
const {StringDecoder} = require("string_decoder");
const {APP} = require("../electron");
var events = new EventEmitter();

// Scryfall serves the bulk files as gzipped JSONL. Depending on whether the CDN
// sets Content-Encoding, fetch may or may not have decompressed the body already,
// so the gzip header is detected instead of assumed.
function toNodeStream(body) {
    if (!body) throw new Error('Response has no body');
    if (typeof body.pipe === 'function') return body;
    return Readable.fromWeb(body);
}

// Reads the first two bytes, pushes them back and reports whether they are the gzip magic number.
function startsWithGzipMagic(stream) {
    return new Promise((resolve, reject) => {
        let head = Buffer.alloc(0);
        const cleanup = () => {
            stream.removeListener('readable', onReadable);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        };
        const finish = () => {
            cleanup();
            if (head.length) stream.unshift(head);
            resolve(head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b);
        };
        const onReadable = () => {
            const chunk = stream.read();
            if (!chunk) return;
            head = head.length ? Buffer.concat([head, chunk]) : chunk;
            if (head.length >= 2) finish();
        };
        const onEnd = () => finish();
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        stream.on('readable', onReadable);
        stream.once('end', onEnd);
        stream.once('error', onError);
    });
}

// Yields the stream line by line without buffering the whole file as one string.
async function* readLines(stream) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    for await (const chunk of stream) {
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            yield buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
        }
    }
    buffer += decoder.end();
    if (buffer.length) yield buffer;
}
function Scryfall() {
    this.lastCreated = null;
    this.isRunning = false;
    this.db = null;
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
        data.cards = await this.downloadBulkCards(oracle);
        return data;
    } catch (err) {
        console.error('Scryfall.getBulkData error:', err);
        throw err;
    }
};

// Downloads a bulk-data entry (gzipped JSONL) and returns the parsed cards.
Scryfall.prototype.downloadBulkCards = async function downloadBulkCards(bulk) {
    const uri = bulk.jsonl_download_uri || bulk.download_uri;
    if (!uri) throw new Error('Bulk data entry has no download uri');

    const downloadResp = await fetch(uri, {
        method: 'GET',
        headers: {
            'Accept'    : '*/*',
            'User-Agent': this.header['User-Agent']
        }
    });
    if (!downloadResp.ok) throw new Error(`Failed to download ${bulk.type}: ${downloadResp.status} ${downloadResp.statusText}`);

    let source = toNodeStream(downloadResp.body);
    if (await startsWithGzipMagic(source)) {
        const gunzip = zlib.createGunzip();
        source.once('error', (err) => gunzip.destroy(err));
        source = source.pipe(gunzip);
    }

    const cards = [];
    let lineNumber = 0;
    let seenContent = false;
    let jsonArray = null; // set when the payload is a legacy JSON array instead of JSONL
    for await (const rawLine of readLines(source)) {
        lineNumber++;
        if (jsonArray) {
            jsonArray.push(rawLine);
            continue;
        }
        const line = rawLine.trim();
        if (!line) continue;
        if (!seenContent && line[0] === '[') {
            jsonArray = [rawLine];
            continue;
        }
        seenContent = true;
        try {
            cards.push(JSON.parse(line));
        } catch (err) {
            console.warn(`Scryfall: skipping unparsable bulk line ${lineNumber}:`, err.message);
            continue;
        }
        if (cards.length % 5000 === 0) {
            this.event.emit('parsingBulkData', {parsed: cards.length});
        }
    }

    if (jsonArray) {
        const parsed = JSON.parse(jsonArray.join('\n'));
        if (!Array.isArray(parsed)) throw new Error(`Unexpected bulk payload for ${bulk.type}`);
        cards.push(...parsed);
    }
    this.event.emit('parsingBulkData', {parsed: cards.length});
    return cards;
};

Scryfall.prototype.insertBulkData = async function insertBulkData(data) {
    if (!data || !data.cards) {
        console.warn('No data to insert into database');
        return;
    }
    const db = this.db;
    var cards = data.cards;

    for (let i = 0; i < cards.length; i++){
        const card = cards[i];
        const current = i + 1;
        this.event.emit('insertingCard', { current: current, total: cards.length });
        if (card.layout === "art_series" || card.layout === "token" || card.layout === "emblem" || card.layout === "vanguard" || card.layout === "double_faced_token" || card.layout === "planar") {
            continue;
        }

        card._id = card.oracle_id || card.card_faces[0].oracle_id;
        let doc = null;
        try {
            // getSingle already returns a Promise
            doc = await db.getSingle('card', { _id: card._id });
        } catch (err) {
            console.error('Error checking for existing card in database:', err);
        }

        let updateImages = true;
        if (!doc) {
            try {
                await db.add('card', card, false);
            } catch (err) {
                console.error('Error inserting card into database:', err);
            }
        } else {
            if (doc.image_status == 'highres_scan' || doc.image_status == card.image_status) {
                if (fs.existsSync(`${APPRES}/assets/card/front/${card._id}.png`)){
                    updateImages = false;
                }
            }
            if(doc.set != card.set){
                updateImages = true;
            }
            try {
                // db.update expects (dbName, query, setDoc, noEmit)
                // remove _id from setDoc to avoid trying to modify it
                const setDoc = Object.assign({}, card);
                await db.update('card', {_id: card._id}, setDoc, {});
            } catch (err) {
                console.error('Error updating card in database:', err);
            }
        }

        if (updateImages) {
            // wait until images are downloaded and written to disk
            try {
                await this.downloadCardImages(card);
            } catch (e) {
                console.error('downloadCardImages failed for', card._id, e);
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
            const response = await fetch(imageUrl, {
                method: 'GET',
                headers: this.header
            });
            if (!response.ok) throw new Error(`Failed fetching image: ${response.status} ${response.statusText}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await fsPromises.writeFile(`${APPRES}/assets/card/front/${card._id}.png`, buffer);
            return;
        }

        switch(card.layout){
            case 'flip':
            case 'transform':
            case 'modal_dfc':
            case 'meld': {
                const resp1 = await fetch(card.card_faces[0].image_uris.png, {
                    method: 'GET',
                    headers: this.header
                });
                if (!resp1.ok) throw new Error(`Failed fetching image face 1: ${resp1.status}`);
                const buf1 = Buffer.from(await resp1.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/front/${card._id}.png`, buf1);

                const resp2 = await fetch(card.card_faces[1].image_uris.png, {
                    method: 'GET',
                    headers: this.header
                });
                if (!resp2.ok) throw new Error(`Failed fetching image face 2: ${resp2.status}`);
                const buf2 = Buffer.from(await resp2.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/back/${card._id}.png`, buf2);
                return;
            }
            default: {
                // fallback to first face
                const resp = await fetch(card.card_faces && card.card_faces[0] ? card.card_faces[0].image_uris.png : null, {
                    method: 'GET',
                    headers: this.header
                });
                if (!resp || !resp.ok) throw new Error('No image available for card');
                const buf = Buffer.from(await resp.arrayBuffer());
                await fsPromises.writeFile(`${APPRES}/assets/card/front/${card._id || card._id}.png`, buf);
                return;
            }
        }
    } catch (e){
        console.log(`Error downloading images for card ${card.name} (${card._id}), retrying...`, e);
        // exponential backoff/retry could be used; keep simple retry after delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.downloadCardImages(card);
    }
}

Scryfall.prototype.on = function on(...args) {
    this.event.on(...args);
}
module.exports = Scryfall;

