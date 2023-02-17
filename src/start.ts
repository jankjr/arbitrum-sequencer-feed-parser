import { ArbitrumSequencerFeed } from "./ArbitrumSequencerFeed";

const seqFeed = new ArbitrumSequencerFeed()

seqFeed.onUpdate(tx => {
    console.log(tx.toJSON())
})

seqFeed.init()