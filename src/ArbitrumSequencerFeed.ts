import ws from "ws"
import * as ethers from "ethers"
import { hexlify, JsonRpcApiProvider, JsonRpcProvider } from "ethers"
class UpdateEmitter<EntityType> {
    private listeners: ((value: EntityType) => void)[] = []

    public emitUpdate = (update: EntityType) => {
        for (const listener of this.listeners) {
            try {
                listener(update)
            } catch (e) { }
        }
    }

    public onUpdate(fn: (value: EntityType) => void) {
        this.listeners.push(fn)
        return () => this.listeners.splice(this.listeners.indexOf(fn), 1)
    }
    get size() {
        return this.listeners.length
    }
}
interface Message {
    header: {
        kind: L1MessageType,
        sender: string
        blockNumber: number
        timestamp: number,
        requestId: string
        baseFeeL1: string
    },
    l2Msg: string
}

const reader = (buff: Buffer) => {
    let cursor = 0
    return {
        remainingSize: () => buff.length - cursor,
        readUint64: () => {
            const out = buff.readBigUInt64BE(cursor)
            cursor += 8
            return Number(out)
        },
        readByte: () => buff.readUInt8(cursor++),
        readSlice: (s: number) => {
            const sub = buff.subarray(cursor, cursor + s)
            cursor += s
            return sub
        },
        readRest: () => {
            return buff.subarray(cursor, buff.length)
        }
    }
}

enum L2MsgKinds {
    L2MessageKind_UnsignedUserTx = 0,
    L2MessageKind_ContractTx = 1,
    L2MessageKind_NonmutatingCall = 2,
    L2MessageKind_Batch = 3,
    L2MessageKind_SignedTx = 4,
    L2MessageKind_Heartbeat = 5,
    L2MessageKind_SignedCompressedTx = 6
}
enum L1MessageType {
    L1MessageType_L2Message = 3,
    L1MessageType_EndOfBlock = 6,
    L1MessageType_L2FundedByL1 = 7,
    L1MessageType_RollupEvent = 8,
    L1MessageType_SubmitRetryable = 9,
    L1MessageType_BatchForGasEstimation = 10,
    L1MessageType_Initialize = 11,
    L1MessageType_EthDeposit = 12,
    L1MessageType_BatchPostingReport = 13,
    L1MessageType_Invalid = 0xFF
}

export class ArbitrumSequencerFeed extends UpdateEmitter<ethers.Transaction> {
    txCount = 0;

    constructor() {
        super()
    }
    async init() {

        const w = new ws.WebSocket(
            "wss://arb1.arbitrum.io/feed",
            {
                headers: {
                    "Arbitrum-Feed-Client-Version": "2"
                }
            }
        )


        const parseL2Message = (start: number, l2MsgBuffer: Buffer, d: number) => {

            const l2MsgReader = reader(l2MsgBuffer)

            const kind = l2MsgReader.readByte() as L2MsgKinds
            switch (kind) {
                case L2MsgKinds.L2MessageKind_Batch:
                    if (d >= 16) {
                        throw new Error("L2 message batches have a max depth of 16")
                    }
                    while (1) {
                        if (l2MsgReader.remainingSize() < 65) {
                            break
                        }
                        const size = l2MsgReader.readUint64()
                        if (size == 0) {
                            break
                        }

                        const batchMsg = l2MsgReader.readSlice(size)
                        parseL2Message(start, batchMsg, d + 1)
                    }
                    break
                case L2MsgKinds.L2MessageKind_SignedTx:
                    const tx = ethers.Transaction.from('0x'+l2MsgReader.readRest().toString("hex"))
                    this.emitUpdate(tx)
                    break
                case L2MsgKinds.L2MessageKind_Heartbeat:
                case L2MsgKinds.L2MessageKind_SignedCompressedTx:
                case L2MsgKinds.L2MessageKind_UnsignedUserTx:
                case L2MsgKinds.L2MessageKind_ContractTx:
                case L2MsgKinds.L2MessageKind_NonmutatingCall:
                    break
            }
        }
        w.on("close", () => {
            this.init()
        })

        w.on("message", msg => {
            const start = Date.now()
            const parsed = JSON.parse(msg.toString())
            if (!parsed.messages) {
                console.log(parsed)
                return
            }
            for (const m of parsed.messages) {
                const {
                    header,
                    l2Msg
                } = m.message.message as Message

                if (header.kind === L1MessageType.L1MessageType_L2Message) {
                    try {
                        parseL2Message(start, Buffer.from(l2Msg, "base64"), 0)
                    } catch (e) {
                        console.log(e)
                    }
                }
            }
        })
    }
}
