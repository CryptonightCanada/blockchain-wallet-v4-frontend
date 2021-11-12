import BigNumber from 'bignumber.js'
import { Signer } from 'ethers'

import { NftAsset, NftOrderSide, NftOrdersType, SellOrder } from '@core/network/api/nfts/types'

import {
  _atomicMatch,
  _buyOrderValidationAndApprovals,
  _cancelOrder,
  calculateAtomicMatchFees,
  calculatePaymentProxyApprovals,
  calculateProxyApprovalFees,
  calculateProxyFees,
  createMatchingOrders,
  createSellOrder,
  NULL_ADDRESS
} from './utils'

export const cancelNftListing = async (sellOrder: SellOrder, signer: Signer) => {
  const cancelled = await _cancelOrder({ sellOrder, signer })
  return cancelled
}

export const fulfillNftSellOrder = async (
  asset: NftAsset,
  signer: Signer,
  provider: ethers.providers.Provider,
  startPrice = 0.011, // The starting price for auctions / sale price for fixed price sale orders (TODO: Remove default 0.1 value)
  endPrice: number | null = null, // Implement later for to enable dutch auction sales.
  waitForHighestBid = false // True = English auction
) => {
  const signedOrder = await createSellOrder(asset, signer, startPrice, endPrice, waitForHighestBid)
  // 1. use the _makeSellOrder to create the object & initialize the proxy contract for this sale.
  const accountAddress = await signer.getAddress()
  const order = await _makeSellOrder({
    accountAddress,
    asset,
    buyerAddress: '0x0000000000000000000000000000000000000000',
    expirationTime: 0,
    extraBountyBasisPoints: 0,
    paymentTokenAddress: '0x0000000000000000000000000000000000000000',
    quantity: 1,
    startAmount: 0.1,
    waitForHighestBid: false
  })
  // 2. Validation of sell order fields & Transaction Approvals (Proxy initialized here if needed also)
  const validatedAndApproved = await _sellOrderValidationAndApprovals({ order, signer })
  console.log(`Successful approvals and validations?: ${validatedAndApproved}`)
  // 3. Compute hash of the order and output {...order, hash:hash(order)}
  const hashedOrder = {
    ...order,
    hash: getOrderHash(order)
  }
  // 4. Obtain a signature from the signer (using the mnemonic & Ethers JS) over the hash and message.
  let signature
  try {
    signature = await _authorizeOrder(hashedOrder, signer, provider)
  } catch (error) {
    console.error(error)
    throw new Error('You declined to authorize your auction')
  }

  const orderWithSignature = {
    ...hashedOrder,
    ...signature
  }
  console.log('next up, try to post this to the OpenSea API:')
  console.log(signedOrder)
  return signedOrder
}

// TODO: Be able to pass in custom value for price for making auction bids.
export const fulfillNftOrder = async (order: NftOrdersType['orders'][0], signer: Signer) => {
  const { buy, sell } = await createMatchingOrders(order, signer)
  // Perform buy order validations (abstracted away from _atomicMatch because english auction bids don't hit that function)
  // await _buyOrderValidationAndApprovals({ order: buy, signer })
  // Is an english auction sale
  if (order.waitingForBestCounterOrder) {
    await _buyOrderValidationAndApprovals({ order: buy, signer })
    console.log('Post buy order to OpenSea API because its an english auction')
    console.log(buy)
    // return buy
  }
  // Is a dutch auction TODO: Find out why validations fail for buy order validations
  else if (order.saleKind === 1) {
    throw new Error('Dutch auctions not currently supported')
    // await _atomicMatch({ buy, sell, signer })
  }
  // Is a fixed price sale
  else {
    await _atomicMatch({ buy, sell, signer })
  }
}

// Calculates all the fees a user will need to pay/encounter on their journey to either sell/buy an NFT
// order and counterOrder needed for sell orders, only order needed for buy order calculations (May need to put a default value here in future / change the way these are called into two seperate functions?)
export const calculateGasFees = async (order, counterOrder, signer) => {
  let totalFees = '0'
  let proxyFees = '0'
  let approvalFees = '0'
  let gasFees = '0'
  // Sell orders always need proxy address and approval:
  if (order.side === NftOrderSide.Sell) {
    // 1. Calculate the gas cost of deploying proxy if needed (can estimate using ethers)
    proxyFees = (await calculateProxyFees(signer)).toString()
    // 2. Calculate the gas cost of making the approvals (can only estimate using ethers if the proxy has been deployed, otherwise can add a safe value here)
    approvalFees =
      proxyFees.toString() === '0'
        ? (await calculateProxyApprovalFees(order, signer)).toString()
        : '300000'
    totalFees = new BigNumber(approvalFees).plus(new BigNumber(proxyFees)).toString()
  }
  // Buy orders dont need any approval or proxy IF payment token is Ether.
  // However, if payment token is an ERC20 approval must be given to the payment proxy address
  else {
    // 1. Calculate gas cost of approvals (if needed) - possible with ethers
    approvalFees =
      order.paymentToken !== NULL_ADDRESS
        ? (await calculatePaymentProxyApprovals(order, signer)).toString()
        : '0'
    // 2. Caclulate the gas cost of the _atomicMatch function call
    gasFees =
      approvalFees === '0'
        ? (await calculateAtomicMatchFees(order, counterOrder, signer)).toString()
        : '350000'
    totalFees = new BigNumber(approvalFees).plus(new BigNumber(gasFees)).toString()
  }
  return {
    approvalFees,
    gasFees,
    proxyFees,
    totalFees
  }
}

// https://codesandbox.io/s/beautiful-euclid-nd7s8?file=/src/index.ts
// metamask https://etherscan.io/tx/0xb52c163434d85e79a63e34cadbfb980d928e4e70129284ae084d9ad992ba9778
// bc.com https://etherscan.io/tx/0xdb0620e6e1b186f4f84e4740b2453506b61416d79fd7de01a6e7ed2f9e5e3623
