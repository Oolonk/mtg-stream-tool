const nedb = require("@seald-io/nedb");
const header = {
    'Content-Type': 'application/json',
    "Accept"       : "application/json",
    "User-Agent"   : `MTG Stream Overlay`
}
const scryfallApiURL = 'https://api.scryfall.com';
var db = null;
async function importDeckList(url) {
    if(db == null){
       db = new nedb({
            filename: path.join(APPRES, 'db', 'card'),
            autoload: true
        });
    }
    const urlObject = new URL(url);
    switch (urlObject.hostname) {
        case 'archidekt.com':
            return await importFromArchidekt(url);
        case 'moxfield.com':
            return await importFromMoxfield(url);
        default:
            return null;
    }

}

function dbFindOne(query) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve(null);
        db.findOne(query, (err, doc) => {
            if (err) return reject(err);
            resolve(doc);
        });
    });
}

async function importFromArchidekt(url) {
    const apiUrl = 'https://archidekt.com/api/decks/#ID#/';
    const regex = /https?:\/\/(?:www\.)?archidekt\.com\/decks\/(\d+)(?:\/|$)/;
    const id = (url.match(regex) || [])[1];
    if (id == null) {
        return null;
    }
    const data = await fetch(apiUrl.replace('#ID#', id), {
        method: 'GET',
        headers: header
    });
    const json = await data.json();
    var colors = [];
    const deckname = json.name;
    var cards = await json.cards;
    var sideboard = cards.filter(card => card.categories.includes('Sideboard'));
    var commander = cards.filter(card => card.categories.includes('Commander'));
    var mainboard = cards.filter(card => !card.categories.includes('Sideboard') && !card.categories.includes('Maybeboard')
        && !card.categories.includes('Commander') && !card.categories.includes('Tokens & Extras')
    );
    var cardList = {
        commander: [],
        mainboard: [],
        sideboard: [],
    }

    for (const card of commander) {
        try {
            const i = cardList.commander.findIndex(e => e.id === card.card.oracleCard.uid);
            if (i > -1) {
                cardList.commander[i].quantity += card.quantity;
            } else {
                let cardDB = null;
                try {
                    cardDB = await dbFindOne({ _id: card.card.oracleCard.uid });
                    cardDB.color_identity.forEach(color => {
                        if(!colors.includes(color)){
                            colors.push(color);
                        }
                    });
                } catch (err) {
                    // ignore lookup errors, proceed without card details
                    cardDB = null;
                }
                cardList.commander.push({
                    id: card.card.oracleCard.uid,
                    quantity: card.quantity,
                    card: cardDB
                });
            }
        } catch (err) {
            // catch per-card errors so one bad card doesn't break the whole import
            console.error('Error processing commander card', err);
        }
    }

    for (const card of sideboard) {
        try {
            const i = cardList.sideboard.findIndex(e => e.id === card.card.oracleCard.uid);
            if (i > -1) {
                cardList.sideboard[i].quantity += card.quantity;
            } else {
                let cardDB = null;
                try {
                    cardDB = await dbFindOne({ _id: card.card.oracleCard.uid });
                    cardDB.colors.forEach(color => {
                        if(!colors.includes(color)){
                            colors.push(color);
                        }
                    });
                } catch (err) {
                    cardDB = null;
                }
                cardList.sideboard.push({
                    id: card.card.oracleCard.uid,
                    quantity: card.quantity,
                    card: cardDB,
                });
            }
        } catch (err) {
            console.error('Error processing sideboard card', err);
        }
    }

    for (const card of mainboard) {
        try {
            const i = cardList.mainboard.findIndex(e => e.id === card.card.oracleCard.uid);
            if (i > -1) {
                cardList.mainboard[i].quantity += card.quantity;
            } else {
                let cardDB = null;
                try {
                    cardDB = await dbFindOne({ _id: card.card.oracleCard.uid });
                    cardDB.colors.forEach(color => {
                        if(!colors.includes(color)){
                            colors.push(color);
                        }
                    });
                } catch (err) {
                    cardDB = null;
                }
                cardList.mainboard.push({
                    id: card.card.oracleCard.uid,
                    quantity: card.quantity,
                    card: cardDB,
                });
            }
        } catch (err) {
            console.error('Error processing mainboard card', err);
        }
    }
    for(const board in cardList){
        for(const id in cardList[board]){
            delete cardList[board][id].id;
        }
    }
    cardList.colors = colors
    cardList.deckname = deckname;
    return cardList;
}

async function importFromMoxfield(url) {
    const apiUrl = 'https://api.moxfield.com/v3/decks/all/#ID#/';
    const regex = /https?:\/\/(?:www\.)?moxfield\.com\/decks\/([^\/?#]+)(?:\/|$)/;
    const id = (url.match(regex) || [])[1];
    if (id == null) {
        return null;
    }
    const data = await fetch(apiUrl.replace('#ID#', id));
    const json = await data.json();
    var colors = json.colors;
    var deckname = json.name;
    var boards =  await json.boards;
    var cardList = {
        commander: [],
        mainboard: [],
        sideboard: [],
    }
    if(boards.commanders.count > 0) {
        for(const id in boards.commanders.cards) {
            const card = boards.commanders.cards[id];
            try{
                const cardId = card.card.scryfall_id;
                const oracleId = await getOracleIdById(cardId);
                if(oracleId == null){
                    continue;
                }
                const i = cardList.commander.findIndex(e => e.id === oracleId);
                if (i > -1) {
                    cardList.commander[i].quantity += card.quantity;
                } else {
                    let cardDB = null;
                    try {
                        cardDB = await dbFindOne({ _id: oracleId });
                    } catch (err) {
                        cardDB = null;
                    }
                    cardList.commander.push({
                        id: oracleId,
                        quantity: card.quantity,
                        card: cardDB,
                    });
                }
            }catch(e){
                console.error(e);
            }
        }
    }
    if(boards.sideboard.count > 0) {
        for(const id in boards.sideboard.cards) {
            const card = boards.sideboard.cards[id];
            try{
                const cardId = card.card.scryfall_id;
                const oracleId = await getOracleIdById(cardId);
                if(oracleId == null){
                    continue;
                }
                const i = cardList.sideboard.findIndex(e => e.id === oracleId);
                if (i > -1) {
                    cardList.sideboard[i].quantity += card.quantity;
                } else {
                    let cardDB = null;
                    try {
                        cardDB = await dbFindOne({ _id: oracleId });
                    } catch (err) {
                        cardDB = null;
                    }
                    cardList.sideboard.push({
                        id: oracleId,
                        quantity: card.quantity,
                        card: cardDB,
                    });
                }
            }catch(e){
                console.error(e);
            }
        }
    }
    if(boards.mainboard.count > 0) {
        for(const id in boards.mainboard.cards) {
            const card = boards.mainboard.cards[id];
            try{
                const cardId = card.card.scryfall_id;
                const oracleId = await getOracleIdById(cardId);
                if(oracleId == null){
                    continue;
                }
                const i = cardList.mainboard.findIndex(e => e.id === oracleId);
                if (i > -1) {
                    cardList.mainboard[i].quantity += card.quantity;
                } else {
                    let cardDB = null;
                    try {
                        cardDB = await dbFindOne({ _id: oracleId });
                    } catch (err) {
                        cardDB = null;
                    }
                    cardList.mainboard.push({
                        id: oracleId,
                        quantity: card.quantity,
                        card: cardDB,
                    });
                }
            }catch(e){
                console.error(e);
            }
        }
    }
    if(boards.companions.count > 0) {
        for(const id in boards.companions.cards) {
            const card = boards.companions.cards[id];
            try{
                const cardId = card.card.scryfall_id;
                const oracleId = await getOracleIdById(cardId);
                if(oracleId == null){
                    continue;
                }
                const i = cardList.mainboard.findIndex(e => e.id === oracleId);
                if (i > -1) {
                    cardList.mainboard[i].quantity += card.quantity;
                } else {
                    let cardDB = null;
                    try {
                        cardDB = await dbFindOne({ _id: oracleId });
                    } catch (err) {
                        cardDB = null;
                    }
                    cardList.mainboard.push({
                        id: oracleId,
                        quantity: card.quantity,
                        card: cardDB,
                    });
                }
            }catch(e){
                console.error(e);
            }
        }
    }
    cardList.deckname = deckname;
    cardList.colors = json.colors;
    return cardList;
}
async function getOracleIdById(id) {
    const response = await fetch(`${scryfallApiURL}/cards/${id}`, {
        method: 'GET',
        headers: header
    });
    if (!response.ok) {
        return null;
    }
    var data = {};
    const json = await response.json();
    try{
        return json.oracle_id
    }catch(e){}
    return null;
}
module.exports = {
    importDeckList: importDeckList
}

const COLORS = {
    'White': 'W',
    'Blue': 'U',
    'Black': 'B',
    'Red': 'R',
    'Green': 'G'

}