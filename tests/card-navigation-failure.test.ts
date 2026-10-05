import { describe, expect, it } from 'vitest'
import {
  classifyCardNavigationFailure,
  classifyCardNavigationException
} from '../src/main/finance/card-navigation-failure'

describe('safe Chromium navigation failure classification', () => {
  it('projects only known local exception categories, never error names or messages from user data', () => {
    expect(classifyCardNavigationException(new TypeError('work.then is not a function'))).toEqual({
      errorName: 'TypeError',
      errorHint: 'then_not_callable'
    })
    expect(
      classifyCardNavigationException(
        new TypeError("Cannot read properties of undefined (reading 'then')")
      )
    ).toEqual({
      errorName: 'TypeError',
      errorHint: 'undefined_property'
    })
    expect(classifyCardNavigationException(new ReferenceError('PRIVATE is not defined'))).toEqual({
      errorName: 'ReferenceError',
      errorHint: 'unknown'
    })
    const custom = { name: 'PRIVATE-PASSWORD', message: 'SECRET-CARD-1234567890123456' }
    expect(classifyCardNavigationException(custom)).toEqual({
      errorName: 'unknown',
      errorHint: 'unknown'
    })
    let calls = 0
    const getter = Object.defineProperty({}, 'message', {
      get: () => {
        calls++
        return 'SECRET'
      }
    })
    expect(classifyCardNavigationException(getter)).toEqual({
      errorName: 'unknown',
      errorHint: 'unknown'
    })
    expect(calls).toBe(0)
  })
  it.each([
    ['ERR_ABORTED', 'aborted'],
    ['ERR_CERT_AUTHORITY_INVALID', 'tls'],
    ['ERR_SSL_PROTOCOL_ERROR', 'tls'],
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy'],
    ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy'],
    ['ERR_INVALID_AUTH_CREDENTIALS', 'authentication'],
    ['ERR_NAME_NOT_RESOLVED', 'dns'],
    ['ERR_CONNECTION_RESET', 'connection'],
    ['ERR_CONNECTION_TIMED_OUT', 'timeout'],
    ['ERR_BLOCKED_BY_CLIENT', 'blocked'],
    ['ERR_FAILED', 'unknown']
  ])('reports only fixed code %s and category', (code, category) => {
    expect(
      classifyCardNavigationFailure({ code, message: 'SECRET-PASSWORD PAN-1234567890123456' })
    ).toEqual({ code, category })
    expect(
      classifyCardNavigationFailure(
        new Error(`net::${code} loading 'https://PRIVATE-ACCOUNT.example/?token=SECRET'`)
      )
    ).toEqual({ code, category })
  })
  it('supports Electron direct net prefixes and known errno without returning numbers or URL text', () => {
    expect(
      classifyCardNavigationFailure(
        new Error("ERR_CERT_DATE_INVALID (-201) loading 'https://PRIVATE'")
      )
    ).toEqual({ code: 'ERR_CERT_DATE_INVALID', category: 'tls' })
    expect(classifyCardNavigationFailure({ errno: -105 })).toEqual({
      code: 'ERR_NAME_NOT_RESOLVED',
      category: 'dns'
    })
    expect(classifyCardNavigationFailure({ code: 'net::ERR_PROXY_CONNECTION_FAILED' })).toEqual({
      code: 'ERR_PROXY_CONNECTION_FAILED',
      category: 'proxy'
    })
  })
  it('does not scan embedded messages, unknown net values, arbitrary strings or getters', () => {
    const values: unknown[] = [
      'net::ERR_CERT_DATE_INVALID SECRET',
      new Error('PRIVATEACCOUNT net::ERR_CERT_DATE_INVALID'),
      { code: 'ERR_PRIVATE_SECRET', errno: 123456789 },
      new Error('net::ERR_CUSTOMER_SECRET_123'),
      Object.create({ code: 'ERR_ABORTED' }),
      null,
      {
        code: {
          toString: () => {
            throw new Error('must not run')
          }
        }
      }
    ]
    let getterCalls = 0
    values.push(
      Object.defineProperty({}, 'message', {
        get: () => {
          getterCalls++
          return 'ERR_FAILED SECRET'
        }
      })
    )
    for (const value of values)
      expect(classifyCardNavigationFailure(value)).toEqual({ code: 'UNKNOWN', category: 'unknown' })
    expect(getterCalls).toBe(0)
    const output = JSON.stringify(values.map(classifyCardNavigationFailure))
    for (const privateValue of ['SECRET', 'PRIVATEACCOUNT', '123456789'])
      expect(output).not.toContain(privateValue)
  })
})
