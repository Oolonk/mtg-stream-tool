class Deck {
    constructor(params) {
        if (!params)
            params = {};
        this.name = params.name || "";
        this.colors = params.colors || [];
        this.decklist = params.decklist || [];
    }
}