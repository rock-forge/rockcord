'use strict';

const { RangeError } = require('../errors');

/**
 * Data structure that makes it easy to interact with a bitfield.
 */
class BitField {
  /**
   * @param {BitFieldResolvable} [bits=this.constructor.defaultBit] Bit(s) to read from
   */
  constructor(bits = this.constructor.defaultBit) {
    /**
     * Bitfield of the packed bits
     * @type {number|bigint}
     */
    this.bitfield = this.constructor.resolve(bits);
  }

  /**
   * Checks whether the bitfield has a bit, or any of multiple bits.
   * @param {BitFieldResolvable} bit Bit(s) to check for
   * @returns {boolean}
   */
  any(bit) {
    return (BigInt(this.bitfield) & BigInt(this.constructor.resolve(bit))) !== 0n;
  }

  /**
   * Checks if this bitfield equals another
   * @param {BitFieldResolvable} bit Bit(s) to check for
   * @returns {boolean}
   */
  equals(bit) {
    return this.bitfield === this.constructor.resolve(bit);
  }

  /**
   * Checks whether the bitfield has a bit, or multiple bits.
   * @param {BitFieldResolvable} bit Bit(s) to check for
   * @returns {boolean}
   */
  has(bit) {
    bit = this.constructor.resolve(bit);
    return (BigInt(this.bitfield) & BigInt(bit)) === BigInt(bit);
  }

  /**
   * Gets all given bits that are missing from the bitfield.
   * @param {BitFieldResolvable} bits Bit(s) to check for
   * @param {...*} hasParams Additional parameters for the has method, if any
   * @returns {string[]}
   */
  missing(bits, ...hasParams) {
    return new this.constructor(bits).remove(this).toArray(...hasParams);
  }

  /**
   * Freezes these bits, making them immutable.
   * @returns {Readonly<BitField>}
   */
  freeze() {
    return Object.freeze(this);
  }

  /**
   * Adds bits to these ones.
   * @param {...BitFieldResolvable} [bits] Bits to add
   * @returns {BitField} These bits or new BitField if the instance is frozen.
   */
  add(...bits) {
    let total = 0n;
    for (const bit of bits) {
      total |= BigInt(this.constructor.resolve(bit));
    }
    const result = this.constructor.convert(BigInt(this.bitfield) | total);
    if (Object.isFrozen(this)) return new this.constructor(result);
    this.bitfield = result;
    return this;
  }

  /**
   * Removes bits from these.
   * @param {...BitFieldResolvable} [bits] Bits to remove
   * @returns {BitField} These bits or new BitField if the instance is frozen.
   */
  remove(...bits) {
    let total = 0n;
    for (const bit of bits) {
      total |= BigInt(this.constructor.resolve(bit));
    }
    const result = this.constructor.convert(BigInt(this.bitfield) & ~total);
    if (Object.isFrozen(this)) return new this.constructor(result);
    this.bitfield = result;
    return this;
  }

  /**
   * Gets an object mapping field names to a {@link boolean} indicating whether the
   * bit is available.
   * @param {...*} hasParams Additional parameters for the has method, if any
   * @returns {Object}
   */
  serialize(...hasParams) {
    const serialized = {};
    for (const [flag, bit] of Object.entries(this.constructor.FLAGS)) serialized[flag] = this.has(bit, ...hasParams);
    return serialized;
  }

  /**
   * Gets an {@link Array} of bitfield names based on the bits available.
   * @param {...*} hasParams Additional parameters for the has method, if any
   * @returns {string[]}
   */
  toArray(...hasParams) {
    return Object.keys(this.constructor.FLAGS).filter(bit => this.has(bit, ...hasParams));
  }

  toJSON() {
    return typeof this.bitfield === 'number' ? this.bitfield : this.bitfield.toString();
  }

  valueOf() {
    return this.bitfield;
  }

  *[Symbol.iterator]() {
    yield* this.toArray();
  }

  /**
   * Data that can be resolved to give a bitfield. This can be:
   * * A bit number (this can be a number literal or a value taken from {@link BitField.FLAGS})
   * * A string bit number
   * * An instance of BitField
   * * An Array of BitFieldResolvable
   * @typedef {number|string|bigint|BitField|BitFieldResolvable[]} BitFieldResolvable
   */

  /**
   * Resolves bitfields to their numeric form.
   * @param {BitFieldResolvable} [bit] bit(s) to resolve
   * @returns {number|bigint}
   */
  static resolve(bit) {
    const { defaultBit } = this;
    if (
      typeof defaultBit === typeof bit &&
      bit >= defaultBit &&
      (typeof bit === 'bigint' || Number.isSafeInteger(bit))
    ) {
      return bit;
    }
    if (bit instanceof BitField) return this.resolve(bit.bitfield);
    if (Array.isArray(bit)) return this.convert(bit.reduce((prev, p) => prev | BigInt(this.resolve(p)), 0n));
    if (typeof bit === 'string') {
      if (/^\d+$/.test(bit)) return this.resolve(typeof defaultBit === 'bigint' ? BigInt(bit) : Number(bit));
      if (this.FLAGS[bit] !== undefined) return this.FLAGS[bit];
    }
    throw new RangeError('BITFIELD_INVALID', bit);
  }

  static convert(bit) {
    return this.resolve(typeof this.defaultBit === 'bigint' ? bit : Number(bit));
  }
}

/**
 * Numeric bitfield flags.
 * <info>Defined in extension classes</info>
 * @type {Object}
 * @abstract
 */
BitField.FLAGS = {};

/**
 * @type {number|bigint}
 * @private
 */
BitField.defaultBit = 0;

module.exports = BitField;
