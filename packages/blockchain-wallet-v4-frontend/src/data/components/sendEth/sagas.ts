import * as A from './actions'
import * as C from 'services/AlertService'
import * as Lockbox from 'services/LockboxService'
import * as S from './selectors'
import { actions, actionTypes, model, selectors } from 'data'
import { ADDRESS_TYPES } from 'blockchain-wallet-v4/src/redux/payment/btc/utils'
import { call, delay, put, select, take } from 'redux-saga/effects'
import {
  change,
  destroy,
  initialize,
  startSubmit,
  stopSubmit
} from 'redux-form'
import {
  equals,
  head,
  identity,
  includes,
  path,
  pathOr,
  prop,
  propOr,
  toLower
} from 'ramda'
import { EthAccountFromType } from 'core/redux/payment/eth/types'
import { EthPaymentType } from 'core/types'
import { Exchange } from 'blockchain-wallet-v4/src'
import { FORM } from './model'
import { ModalNamesType } from 'data/modals/types'
import { promptForLockbox, promptForSecondPassword } from 'services/SagaService'
import {
  SendEthFormActionType,
  SendEthFormAmountActionType,
  SendEthFormDescActionType,
  SendEthFormFeeActionType,
  SendEthFormFromActionType,
  SendEthFormToActionType
} from './types'

const { TRANSACTION_EVENTS } = model.analytics

export const logLocation = 'components/sendEth/sagas'
export default ({ api, coreSagas, networks }) => {
  const initialized = function * (action) {
    try {
      const erc20List = (yield select(
        selectors.core.walletOptions.getErc20CoinList
      )).getOrFail()
      const coin = propOr('ETH', 'payload', action)
      const isErc20 = includes(coin, erc20List)
      let initialValues = {}
      yield put(A.sendEthPaymentUpdatedLoading())
      yield put(actions.components.send.fetchPaymentsAccountExchange(coin))
      let payment = coreSagas.payment.eth.create({
        network: networks.eth
      })
      payment = yield payment.init({ isErc20, coin })
      payment = yield payment.from()
      const defaultFee = path(['fees', 'regular'], payment.value())
      if (isErc20) {
        const erc20AccountR = yield select(
          selectors.core.common.eth.getErc20AccountBalances,
          coin
        )
        const defaultErc20AccountR = erc20AccountR.map(head)
        initialValues = {
          coin,
          fee: defaultFee,
          from: defaultErc20AccountR.getOrElse({})
        }
      } else {
        const ethAccountR = yield select(
          selectors.core.common.eth.getAccountBalances
        )
        const defaultAccountR = ethAccountR.map(head)
        initialValues = {
          coin,
          fee: defaultFee,
          from: defaultAccountR.getOrElse({})
        }
      }
      yield put(initialize(FORM, initialValues))
      yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'sendEthInitialized', e)
      )
    }
  }

  const destroyed = function * () {
    yield put(actions.form.destroy(FORM))
  }

  const firstStepSubmitClicked = function * () {
    try {
      let p = yield select(S.getPayment)
      yield put(A.sendEthPaymentUpdatedLoading())
      let payment = coreSagas.payment.eth.create({
        payment: p.getOrElse({}),
        network: networks.eth
      })
      payment = yield payment.build()
      yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
    } catch (e) {
      yield put(A.sendEthPaymentUpdatedFailure(e))
      yield put(
        actions.logs.logErrorMessage(logLocation, 'firstStepSubmitClicked', e)
      )
    }
  }

  const formChanged = function * (action: SendEthFormActionType) {
    try {
      const form = action.meta.form
      if (!equals(FORM, form)) return
      const payload = action.payload
      const erc20List = (yield select(
        selectors.core.walletOptions.getErc20CoinList
      )).getOrElse([])
      const { coin } = yield select(selectors.form.getFormValues(FORM))
      const isErc20 = includes(coin, erc20List)
      let p = yield select(S.getPayment)
      let payment: EthPaymentType = coreSagas.payment.eth.create({
        payment: p.getOrElse({}),
        network: networks.eth
      })

      switch (action.meta.field) {
        // @ts-ignore
        case 'coin':
          const modalName = isErc20 ? 'ETH' : payload
          yield put(actions.modals.closeAllModals())
          yield put(
            actions.modals.showModal(
              `@MODAL.SEND.${modalName}` as ModalNamesType,
              {
                coin: payload
              }
            )
          )
          break
        case 'from':
          const fromPayload = payload as SendEthFormFromActionType['payload']
          let source
          switch (fromPayload.type) {
            case 'LOCKBOX':
            case 'ACCOUNT':
              source = fromPayload.address
              payment = yield payment.from(source, fromPayload.type)
              break
            case 'CUSTODIAL':
              source = fromPayload.label
              const currency = selectors.core.settings
                .getCurrency(yield select())
                .getOrFail('Failed to get currency')
              let rates
              if (equals(coin, 'ETH')) {
                rates = selectors.core.data.eth
                  .getRates(yield select())
                  .getOrFail('Failed to get ETH rates')
              } else {
                rates = (yield select(
                  selectors.core.data.eth.getErc20Rates,
                  toLower(coin)
                )).getOrFail(`Failed to get ${coin} rates`)
              }
              const cryptoAmt = Exchange.convertCoinToCoin({
                value: fromPayload.available,
                coin,
                baseToStandard: true
              }).value
              const fiat = Exchange.convertCoinUnitToFiat({
                coin,
                value: fromPayload.available,
                fromUnit: 'WEI',
                toCurrency: currency,
                rates: rates
              }).value
              payment = yield payment.from(
                source,
                fromPayload.type,
                fromPayload.available
              )
              yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
              payment = yield payment.amount(fromPayload.available)
              yield put(
                change(FORM, 'amount', {
                  coin: cryptoAmt,
                  fiat,
                  coinCode: coin
                })
              )
              break
          }
          break
        case 'to':
          const toPayload = payload as SendEthFormToActionType['payload']
          const value = pathOr({}, ['value', 'value'], toPayload)
          // @ts-ignore
          payment = yield payment.to(value)
          // Do not block payment update when to is changed w/ isContract check
          yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
          // After updating payment success check if to isContract
          yield put(A.sendEthCheckIsContract(value))
          return
        case 'amount':
          const amountPayload = payload as SendEthFormAmountActionType['payload']
          const coinCode = prop('coinCode', amountPayload)
          const weiAmount = Exchange.convertCoinToCoin({
            baseToStandard: false,
            value: amountPayload.coin,
            coin: coinCode
          }).value
          payment = yield payment.amount(weiAmount)
          break
        case 'description':
          const descPayload = payload as SendEthFormDescActionType['payload']
          payment = yield payment.description(descPayload)
          break
        case 'fee':
          const feePayload = payload as SendEthFormFeeActionType['payload']
          const account = path(['from', 'address'], payment.value())
          // @ts-ignore
          payment = yield payment.fee(feePayload, account)
          break
      }

      yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
    } catch (e) {
      yield put(actions.logs.logErrorMessage(logLocation, 'formChanged', e))
    }
  }

  const maximumAmountClicked = function * (action) {
    try {
      const coinCode = action.payload
      const appState = yield select(identity)
      const currency = selectors.core.settings
        .getCurrency(appState)
        .getOrFail('Failed to get currency')
      let rates, fiat
      if (equals(coinCode, 'ETH')) {
        rates = selectors.core.data.eth
          .getRates(appState)
          .getOrFail('Failed to get ETH rates')
      } else {
        rates = (yield select(
          selectors.core.data.eth.getErc20Rates,
          toLower(coinCode)
        )).getOrFail(`Failed to get ${coinCode} rates`)
      }
      const payment = (yield select(S.getPayment)).getOrElse({})
      const effectiveBalance = prop('effectiveBalance', payment)
      const coin = Exchange.convertCoinToCoin({
        value: effectiveBalance,
        coin: coinCode,
        baseToStandard: true
      }).value
      fiat = Exchange.convertCoinUnitToFiat({
        coin: coinCode,
        value: effectiveBalance,
        fromUnit: 'WEI',
        toCurrency: currency,
        rates: rates
      }).value
      yield put(change(FORM, 'amount', { coin, fiat, coinCode }))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'maximumAmountClicked', e)
      )
    }
  }

  const secondStepSubmitClicked = function * () {
    const { coin } = yield select(selectors.form.getFormValues(FORM))
    const coinModel = (yield select(
      selectors.core.walletOptions.getCoinModel,
      coin
    )).getOrFail()
    yield put(startSubmit(FORM))
    let p = yield select(S.getPayment)
    let payment: EthPaymentType = coreSagas.payment.eth.create({
      payment: p.getOrElse({}),
      network: networks.eth
    })
    const fromType = payment.value().from.type
    const toAddress = path(['to', 'address'], payment.value())
    const fromAddress = path(['from', 'address'], payment.value())

    try {
      // Sign payment
      if (fromType !== 'LOCKBOX') {
        const password = yield call(promptForSecondPassword)
        if (fromType !== 'CUSTODIAL') {
          // @ts-ignore
          payment = yield payment.sign(password, null, null)
        }
      } else if (fromType === 'LOCKBOX') {
        const device = (yield select(
          selectors.core.kvStore.lockbox.getDeviceFromEthAddr,
          fromAddress
        )).getOrFail('missing_device')
        const deviceType = prop('device_type', device)
        yield call(promptForLockbox, 'ETH', deviceType, [toAddress])
        let connection = yield select(
          selectors.components.lockbox.getCurrentConnection
        )
        const transport = prop('transport', connection)
        const scrambleKey = Lockbox.utils.getScrambleKey('ETH', deviceType)
        // @ts-ignore
        payment = yield payment.sign(null, transport, scrambleKey)
      }
      // Publish payment
      if (fromType === 'CUSTODIAL') {
        const value = payment.value()
        if (!value.to) throw new Error('missing_to_from_custodial')
        if (!value.amount) throw new Error('missing_amount_from_custodial')
        yield call(api.withdrawSBFunds, value.to.address, coin, value.amount)
      } else {
        payment = yield payment.publish()
      }
      yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
      // Update metadata
      if (fromType === ADDRESS_TYPES.LOCKBOX) {
        const device = (yield select(
          selectors.core.kvStore.lockbox.getDeviceFromEthAddr,
          fromAddress
        )).getOrFail('missing_device')
        const deviceIndex = prop('device_index', device)
        yield put(
          actions.core.kvStore.lockbox.setLatestTxTimestampEthLockbox(
            deviceIndex,
            Date.now()
          )
        )
        yield take(
          actionTypes.core.kvStore.lockbox.FETCH_METADATA_LOCKBOX_SUCCESS
        )
        yield put(
          actions.core.kvStore.lockbox.setLatestTxEthLockbox(
            deviceIndex,
            payment.value().txId
          )
        )
      } else {
        yield put(actions.core.kvStore.eth.setLatestTxTimestampEth(Date.now()))
        yield take(actionTypes.core.kvStore.eth.FETCH_METADATA_ETH_SUCCESS)
        yield put(actions.core.kvStore.eth.setLatestTxEth(payment.value().txId))
      }
      // Notes
      if (path(['description', 'length'], payment.value())) {
        if (fromType !== ADDRESS_TYPES.LOCKBOX) {
          yield take(actionTypes.core.kvStore.eth.FETCH_METADATA_ETH_SUCCESS)
        }
        if (coinModel.contractAddress) {
          yield put(
            actions.core.kvStore.eth.setTxNotesErc20(
              coin,
              payment.value().txId,
              payment.value().description
            )
          )
        } else {
          yield put(
            actions.core.kvStore.eth.setTxNotesEth(
              payment.value().txId,
              payment.value().description
            )
          )
        }
      }
      // Display success
      if (fromType === ADDRESS_TYPES.LOCKBOX) {
        yield put(actions.components.lockbox.setConnectionSuccess())
        yield delay(4000)
        const device = (yield select(
          selectors.core.kvStore.lockbox.getDeviceFromEthAddr,
          fromAddress
        )).getOrFail('missing_device')
        const deviceIndex = prop('device_index', device)
        yield put(actions.router.push(`/lockbox/dashboard/${deviceIndex}`))
      } else {
        yield put(actions.router.push(coinModel.txListAppRoute))
        yield put(
          actions.alerts.displaySuccess(C.SEND_COIN_SUCCESS, {
            coinName: coinModel.displayName
          })
        )
      }
      yield put(
        actions.analytics.logEvent([
          ...TRANSACTION_EVENTS.SEND,
          coin,
          Exchange.convertCoinToCoin({
            value: payment.value().amount || 0,
            coin,
            baseToStandard: true
          }).value
        ])
      )
      yield put(destroy(FORM))
      yield put(actions.modals.closeAllModals())
    } catch (e) {
      yield put(stopSubmit(FORM))
      if (fromType === ADDRESS_TYPES.LOCKBOX) {
        yield put(actions.components.lockbox.setConnectionError(e))
      } else {
        yield put(
          actions.logs.logErrorMessage(
            logLocation,
            'secondStepSubmitClicked',
            e
          )
        )
        const lowEthBalance = yield select(
          selectors.core.data.eth.getLowEthBalanceWarning()
        )
        yield put(
          actions.analytics.logEvent([
            ...TRANSACTION_EVENTS.SEND_FAILURE,
            coin,
            coinModel.contractAddress && lowEthBalance
              ? 'Potentially insufficient ETH for TX'
              : e
          ])
        )
        yield put(
          actions.alerts.displayError(C.SEND_COIN_ERROR, {
            coinName: coinModel.displayName
          })
        )
      }
    }
  }

  const regularFeeClicked = function * () {
    try {
      const p = yield select(S.getPayment)
      const payment = p.getOrElse({})
      const regularFee = path(['fees', 'regular'], payment)
      yield put(change(FORM, 'fee', regularFee))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'regularFeeClicked', e)
      )
    }
  }

  const checkIsContract = function * ({
    payload
  }: {
    payload: string | EthAccountFromType
  }) {
    try {
      let p = yield select(S.getPayment)
      let payment = coreSagas.payment.eth.create({
        payment: p.getOrElse({}),
        network: networks.eth
      })
      yield put(A.sendEthCheckIsContractLoading())
      const { contract } = yield call(
        api.checkContract,
        typeof payload === 'string' ? payload : payload.address
      )
      const { fee, account } = yield select(selectors.form.getFormValues(FORM))
      payment = yield payment.setIsContract(contract)
      payment = yield payment.fee(fee, account)
      yield put(A.sendEthPaymentUpdatedSuccess(payment.value()))
      yield put(A.sendEthCheckIsContractSuccess(contract))
    } catch (e) {
      yield put(A.sendEthCheckIsContractFailure(e))
    }
  }

  const priorityFeeClicked = function * () {
    try {
      const p = yield select(S.getPayment)
      const payment = p.getOrElse({})
      const priorityFee = path(['fees', 'priority'], payment)
      yield put(change(FORM, 'fee', priorityFee))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'priorityFeeClicked', e)
      )
    }
  }

  const minimumFeeClicked = function * () {
    try {
      const p = yield select(S.getPayment)
      const payment = p.getOrElse({})
      const minFee = path(['fees', 'limits', 'min'], payment)
      yield put(change(FORM, 'fee', minFee))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'minimumFeeClicked', e)
      )
    }
  }

  const maximumFeeClicked = function * () {
    try {
      const p = yield select(S.getPayment)
      const payment = p.getOrElse({})
      const maxFee = path(['fees', 'limits', 'max'], payment)
      yield put(change(FORM, 'fee', maxFee))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'maximumFeeClicked', e)
      )
    }
  }

  return {
    initialized,
    checkIsContract,
    destroyed,
    firstStepSubmitClicked,
    maximumAmountClicked,
    maximumFeeClicked,
    minimumFeeClicked,
    secondStepSubmitClicked,
    formChanged,
    regularFeeClicked,
    priorityFeeClicked
  }
}
