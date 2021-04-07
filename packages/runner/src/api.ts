import {
    _signMessage,
    _generateTransactionMessageToSign,
    _createAccountRawL2Transaction,
    accountScriptHash,
} from "./common";
import {
    core,
    toBuffer,
    Godwoken,
    GodwokenUtils,
    L2Transaction,
    RawL2Transaction,
    RawWithdrawalRequest,
    WithdrawalRequest,
    CreateAccount,
    UInt32LEToNumber,
    numberToUInt32LE,
    u32ToHex,
} from "@godwoken-examples/godwoken";
import { Polyjuice } from "@godwoken-examples/polyjuice";


import { HexString, Cell, Script, Hash, utils } from "@ckb-lumos/base";
import { DeploymentConfig } from "../js/base/index";
import { Indexer } from "@ckb-lumos/indexer";
import { key } from "@ckb-lumos/hd";
import {
    TransactionSkeleton,
    parseAddress,
    sealTransaction,
} from "@ckb-lumos/helpers";
import {
    generateDepositionLock,
    DepositionLockArgs,
    getDepositionLockArgs,
    serializeArgs,
} from "../js/transactions/deposition";
import { common } from "@ckb-lumos/common-scripts";

import { RPC } from "ckb-js-toolkit";
import { deploymentConfig } from "../js/utils/deployment_config";
import path from "path";
import { initializeConfig } from "@ckb-lumos/config-manager";

import { asyncSleep, caculateLayer2LockScriptHash, serializeScript,  waitForBlockSync, privateKeyToCkbAddress, privateKeyToEthAddress } from "./util";

export class Api {

    public ckb_rpc_url: string;
    private ckb_rpc: RPC;

    public godwoken_rpc_url: string;
    public godwoken: Godwoken;

    public validator_code_hash: string;

    private indexer: Indexer | null;
    public indexer_path: string; 

    public polyjuice: Polyjuice | null;

    constructor (
        _ckb_rpc_url: string,
        _godwoken_rpc: string,
        _indexer_path: string
    ) {
        this.indexer_path = _indexer_path;
        this.ckb_rpc_url = _ckb_rpc_url;
        this.godwoken_rpc_url = _godwoken_rpc;

        this.validator_code_hash = "0x20814f4f3ebaf8a297d452aa38dbf0f9cb0b2988a87cb6119c2497de817e7de9";

        this.indexer = null;
        this.ckb_rpc = new RPC(this.ckb_rpc_url);
        this.godwoken = new Godwoken(this.godwoken_rpc_url);

        this.polyjuice = null;
    }

    async syncLayer1 () {
        if (process.env.LUMOS_CONFIG_FILE) {
            process.env.LUMOS_CONFIG_FILE = path.resolve(process.env.LUMOS_CONFIG_FILE);
        }
    
        console.log("LUMOS_CONFIG_FILE:", process.env.LUMOS_CONFIG_FILE);
    
        initializeConfig();
    
        const indexerPath = path.resolve(this.indexer_path);
    
        this.indexer = new Indexer(this.ckb_rpc_url, indexerPath);
        this.indexer.startForever();
    
        console.log("waiting for sync ...");
        await this.indexer.waitForSync();
        console.log("synced ...");
    }

    async sendTx(
        deploymentConfig: DeploymentConfig,
        fromAddress: string,
        amount: string,
        layer2LockArgs: HexString,
        privateKey: HexString,
    ): Promise<Hash> {
        let txSkeleton = TransactionSkeleton({ cellProvider: this.indexer });
    
        const ownerLock: Script = parseAddress(fromAddress);
        const ownerLockHash: Hash = utils.computeScriptHash(ownerLock);
        const depositionLockArgs: DepositionLockArgs = getDepositionLockArgs(
            ownerLockHash,
            layer2LockArgs
        );
        console.log(
            `Layer 2 lock script hash: ${utils.computeScriptHash(
                depositionLockArgs.layer2_lock
            )}`
        );
        const serializedArgs: HexString = serializeArgs(depositionLockArgs);
        const depositionLock: Script = generateDepositionLock(
            deploymentConfig,
            serializedArgs
        );
    
        const outputCell: Cell = {
            cell_output: {
                capacity: "0x" + BigInt(amount).toString(16),
                lock: depositionLock,
            },
            data: "0x",
        };
    
        txSkeleton = txSkeleton.update("outputs", (outputs) => {
            return outputs.push(outputCell);
        });
    
        txSkeleton = await common.injectCapacity(
            txSkeleton,
            [fromAddress],
            BigInt(amount)
        );
    
        txSkeleton = await common.payFeeByFeeRate(
            txSkeleton,
            [fromAddress],
            BigInt(1000)
        );
    
        txSkeleton = common.prepareSigningEntries(txSkeleton);
    
        const message: HexString = txSkeleton.get("signingEntries").get(0)!.message;
        const content: HexString = key.signRecoverable(message, privateKey);
    
        const tx = sealTransaction(txSkeleton, [content]);
    
        const txHash: Hash = await this.ckb_rpc.send_transaction(tx);
    
        return txHash;
    }

    async deposit(
        _privateKey: string,
        _ethAddress: string,
        _amount: string,
    ) {
        if(!this.indexer){
            throw new Error("indexer is null, please run syncLayer1 first!");
        }

        const privateKey = _privateKey;
        const ckbAddress = privateKeyToCkbAddress(privateKey);
        const ethAddress = _ethAddress || privateKeyToEthAddress(privateKey);
        console.log("using eth address:", ethAddress);

        const txHash: Hash = await this.sendTx(
            deploymentConfig,
            ckbAddress,
            _amount,
            ethAddress.toLowerCase(),
            privateKey
        );

        console.log(`txHash ${txHash} is sent!`,);

        // Wait for tx to land on chain.
        while (true) {
            await asyncSleep(1000);
            const txWithStatus = await this.ckb_rpc!.get_transaction(txHash);
            console.log(txWithStatus);
            if (
                txWithStatus &&
                txWithStatus.tx_status &&
                txWithStatus.tx_status.status === "committed"
            ) {
                await waitForBlockSync(this.indexer, this.ckb_rpc!, txWithStatus.tx_status.block_hash);
                break;
            }
        }
        console.log(`tx ${txHash} is now onChain!`);

        //get deposit account id
        const script_hash = caculateLayer2LockScriptHash(ethAddress);
        console.log(`compute_scripthash: ${script_hash}`);
        
        while (true) {
            await asyncSleep(1000); 
            const account_id = await this.godwoken.getAccountIdByScriptHash(script_hash);
            console.log(`account id: ${account_id}`); 
            if(account_id){
                console.log(`account id: ${account_id}`);
                break;
            }
        }

        const account_id = await this.godwoken.getAccountIdByScriptHash(script_hash); 
        return account_id.toString();
    }

    async createCreatorAccount(
        from_id_str: string,
        sudt_id_str: string,
        rollup_type_hash: string,
        privkey: string
    ) {
        const from_id = parseInt(from_id_str);
        const nonce = await this.godwoken.getNonce(from_id);
        const script_args = numberToUInt32LE(parseInt(sudt_id_str));
        const raw_l2tx = _createAccountRawL2Transaction(
            from_id, nonce, this.validator_code_hash, script_args,
        );
        
        const message = _generateTransactionMessageToSign(raw_l2tx, rollup_type_hash);
        const signature = _signMessage(message, privkey);
        console.log("message", message);
        console.log("signature", signature);
        const l2tx: L2Transaction = { raw: raw_l2tx, signature };
        const run_result = await this.godwoken.submitL2Transaction(l2tx);
        console.log("RunResult", run_result);
        const new_account_id = UInt32LEToNumber(run_result.return_data);
        console.log("Created account id:", new_account_id);

        // wait for confirm
        const l2_script: Script = {
            code_hash: this.validator_code_hash,
            hash_type: "data",
            args: script_args
        };
        const l2_script_hash = serializeScript(l2_script);
        while (true) {
            await asyncSleep(1000); 
            const account_id = await this.godwoken.getAccountIdByScriptHash(l2_script_hash);
            console.log(`wait for creator_account_id lands on chain..`);

            if(account_id){
                console.log(`creator_account_id ${account_id} is now on chain!`);
                break;    
            }
        }

        return new_account_id.toString();
    }

    async deploy(
        creator_account_id_str: string,
        init_code: string,
        rollup_type_hash: string,
        privkey: string,
        eth_address?: string
    ) {
        const creator_account_id = parseInt(creator_account_id_str);
        this.polyjuice = new Polyjuice(this.godwoken, {
            validator_code_hash: this.validator_code_hash,
            sudt_id: 1,
            creator_account_id,
        });
        const script_hash = eth_address ? caculateLayer2LockScriptHash(eth_address) : accountScriptHash(privkey);
        const from_id = await this.godwoken.getAccountIdByScriptHash(script_hash);
        if (!from_id) {
            console.log("Can not find account id by script_hash:", script_hash);
            throw new Error(`Can not find account id by script_hash: ${script_hash}`);
        }
        const nonce = await this.godwoken.getNonce(from_id);
        const raw_l2tx = this.polyjuice.generateTransaction(from_id, 0, 0n, init_code, nonce);
        const message = _generateTransactionMessageToSign(raw_l2tx, rollup_type_hash);
        const signature = _signMessage(message, privkey);
        const l2tx: L2Transaction = { raw: raw_l2tx, signature };
        console.log("L2Transaction", l2tx);
        const run_result = await this.godwoken.submitL2Transaction(l2tx);
        console.log("RunResult", run_result);


        // todo: the method of caculateScriptHash seems go wrong.
        // const new_script_hash = this.polyjuice.calculateScriptHash(from_id, nonce);
        // console.log("new script hash", new_script_hash);
        if(!run_result || !run_result.new_scripts)
            throw new Error("run_result or run_result.new_scripts is empty.");
        
        const contract_script_hash = Object.keys(run_result.new_scripts)[0];

        // wait for confirm
        while (true) {
            await asyncSleep(1000); 
            const new_account_id = await this.godwoken.getAccountIdByScriptHash(
                contract_script_hash
            );
            console.log(`contract_id: ${new_account_id}`);

            if(new_account_id){
                break;
            }
        }

        const new_account_id = await this.godwoken.getAccountIdByScriptHash(
            contract_script_hash
        );
        const account_address = await this.polyjuice.accountIdToAddress(new_account_id);
        console.log(`the contract deployed at address ${account_address}`);
        return account_address;
    }

    init_polyjuice (creator_account_id: number) {
        this.polyjuice = new Polyjuice(this.godwoken, {
            validator_code_hash: this.validator_code_hash,
            sudt_id: 1,
            creator_account_id,
        });
    }

    async getAccountId (script_hash: string) {
        const id = await this.godwoken.getAccountIdByScriptHash(script_hash);
        return id;
    }

    async _call(
        method: Function,
        to_id_str: string,
        input_data: string,
        rollup_type_hash: string,
        privkey: string,
    ) {
        if(!this.polyjuice) throw new Error(`Can not find polyjuice instance, please call deploy contract first.`);

        const script_hash = accountScriptHash(privkey);
        const from_id = await this.godwoken.getAccountIdByScriptHash(script_hash);
        if (!from_id) {
            console.log("Can not find account id by script_hash:", script_hash);
            throw new Error(`Can not find account id by script_hash: ${script_hash}`);
        }
        const nonce = await this.godwoken.getNonce(from_id);
        const raw_l2tx = this.polyjuice.generateTransaction(from_id, parseInt(to_id_str), 0n, input_data, nonce);
        const message = _generateTransactionMessageToSign(raw_l2tx, rollup_type_hash);
        const signature = _signMessage(message, privkey);
        const l2tx: L2Transaction = { raw: raw_l2tx, signature };
        console.log("L2Transaction", l2tx);
        const run_result = await method(l2tx);
        console.log("RunResult", run_result);
        console.log("return data", run_result.return_data);
        return run_result;
    }
    
    async call(
        to_id_str: string,
        input_data: string,
        rollup_type_hash: string,
        privkey: string,
    ) {
        this._call(
            this.godwoken.submitL2Transaction.bind(this.godwoken),
            to_id_str, input_data, rollup_type_hash, privkey,
        );
    }
    
    async staticCall(
        to_id_str: string,
        input_data: string,
        rollup_type_hash: string,
        privkey: string,
    ) {
        this._call(
            this.godwoken.executeL2Transaction.bind(this.godwoken),
            to_id_str, input_data, rollup_type_hash, privkey,
        );
    }

}