use crate::oracle::capsules;
use protocol_types::{address::AztecAddress, traits::{Deserialize, Serialize}};

/// A dynamically sized array backed by PXE's non-volatile database (called capsules). Values are persisted until
/// deleted, so they can be e.g. stored during simulation of a transaction and later retrieved during witness
/// generation. All values are scoped per contract address, so external contracts cannot access them.
pub struct CapsuleArray<T> {
    contract_address: AztecAddress,
    /// The base slot is where the array length is stored in capsules. Array elements are stored in consecutive slots
    /// after the base slot. For example, with base slot 5: the length is at slot 5, the first element (index 0) is at
    /// slot 6, the second element (index 1) is at slot 7, and so on.
    base_slot: Field,
}

impl<T> CapsuleArray<T> {
    /// Returns a CapsuleArray connected to a contract's capsules at a base slot. Array elements are stored in
    /// contiguous slots following the base slot, so there should be sufficient space between array base slots to
    /// accommodate elements. A reasonable strategy is to make the base slot a hash of a unique value.
    pub unconstrained fn at(contract_address: AztecAddress, base_slot: Field) -> Self {
        Self { contract_address, base_slot }
    }

    /// Returns the number of elements stored in the array.
    pub unconstrained fn len(self) -> u32 {
        // An uninitialized array defaults to a length of 0.
        capsules::load(self.contract_address, self.base_slot).unwrap_or(0) as u32
    }

    /// Stores a value at the end of the array.
    pub unconstrained fn push<let N: u32>(self, value: T)
    where
        T: Serialize<N>,
    {
        let current_length = self.len();

        // The slot corresponding to the index `current_length` is the first slot immediately after the end of the
        // array, which is where we want to place the new value.
        capsules::store(self.contract_address, self.slot_at(current_length), value);

        // Then we simply update the length.
        let new_length = current_length + 1;
        capsules::store(self.contract_address, self.base_slot, new_length);
    }

    /// Retrieves the value stored in the array at `index`. Throws if the index is out of bounds.
    pub unconstrained fn get<let N: u32>(self, index: u32) -> T
    where
        T: Deserialize<N>,
    {
        assert(index < self.len(), "Attempted to read past the length of a CapsuleArray");

        capsules::load(self.contract_address, self.slot_at(index)).unwrap()
    }

    /// Deletes the value stored in the array at `index`. Throws if the index is out of bounds.
    pub unconstrained fn remove(self, index: u32) {
        let current_length = self.len();
        assert(index < current_length, "Attempted to delete past the length of a CapsuleArray");

        // In order to be able to remove elements at arbitrary indices, we need to shift the entire contents of the
        // array past the removed element one slot backward so that we don't end up with a gap and preserve the
        // contiguous slots. We can skip this when deleting the last element however.
        if index != current_length - 1 {
            // The source and destination regions overlap, but `copy` supports this.
            capsules::copy(
                self.contract_address,
                self.slot_at(index + 1),
                self.slot_at(index),
                current_length - index - 1,
            );
        }

        // We can now delete the last element (which has either been copied to the slot immediately before it, or was
        // the element we meant to delete in the first place) and update the length.
        capsules::delete(self.contract_address, self.slot_at(current_length - 1));
        capsules::store(self.contract_address, self.base_slot, current_length - 1);
    }

    unconstrained fn slot_at(self, index: u32) -> Field {
        // Elements are stored immediately after the base slot, so we add 1 to it to compute the slot for the first
        // element.
        self.base_slot + 1 + index as Field
    }
}

mod test {
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::CapsuleArray;
    use protocol_types::address::AztecAddress;

    global SLOT: Field = 1230;

    unconstrained fn setup() -> AztecAddress {
        TestEnvironment::new().unkonstrained().this_address()
    }

    #[test]
    unconstrained fn empty_array() {
        let contract_address = setup();

        let array: CapsuleArray<Field> = CapsuleArray::at(contract_address, SLOT);
        assert_eq(array.len(), 0);
    }

    #[test(should_fail_with = "Attempted to read past the length of a CapsuleArray")]
    unconstrained fn empty_array_read() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);
        let _: Field = array.get(0);
    }

    #[test]
    unconstrained fn array_push() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);
        array.push(5);

        assert_eq(array.len(), 1);
        assert_eq(array.get(0), 5);
    }

    #[test(should_fail_with = "Attempted to read past the length of a CapsuleArray")]
    unconstrained fn read_past_len() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);
        array.push(5);

        let _ = array.get(1);
    }

    #[test]
    unconstrained fn array_remove_last() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);

        array.push(5);
        array.remove(0);

        assert_eq(array.len(), 0);
    }

    #[test]
    unconstrained fn array_remove_some() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);

        array.push(7);
        array.push(8);
        array.push(9);

        assert_eq(array.len(), 3);
        assert_eq(array.get(0), 7);
        assert_eq(array.get(1), 8);
        assert_eq(array.get(2), 9);

        array.remove(1);

        assert_eq(array.len(), 2);
        assert_eq(array.get(0), 7);
        assert_eq(array.get(1), 9);
    }

    #[test]
    unconstrained fn array_remove_all() {
        let contract_address = setup();

        let array = CapsuleArray::at(contract_address, SLOT);

        array.push(7);
        array.push(8);
        array.push(9);

        array.remove(1);
        array.remove(1);
        array.remove(0);

        assert_eq(array.len(), 0);
    }
}
