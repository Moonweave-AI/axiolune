'use strict';

module.exports = [
  {
    vectorId: 'manifest-contract-digest-mismatch',
    expectedCode: 'IDENTITY_MANIFEST_MISMATCH',
    mutate(manifest) {
      manifest.contracts[0].contractDigest = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    vectorId: 'manifest-mapping-digest-mismatch',
    expectedCode: 'IDENTITY_MANIFEST_MISMATCH',
    mutate(manifest) {
      manifest.contracts[0].mappings[0].mappingDigest = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    vectorId: 'manifest-duplicate-mapping',
    expectedCode: 'DUPLICATE_MANIFEST_MAPPING',
    mutate(manifest) {
      manifest.contracts[0].mappings.push(structuredClone(manifest.contracts[0].mappings[0]));
    },
  },
  {
    vectorId: 'manifest-target-order-mismatch',
    expectedCode: 'UNSORTED_OR_DUPLICATE_MANIFEST_TARGET',
    mutate(manifest) {
      manifest.contracts.reverse();
    },
  },
  {
    vectorId: 'manifest-component-order-mismatch',
    expectedCode: 'IDENTITY_MANIFEST_MISMATCH',
    mutate(manifest) {
      manifest.contracts[0].logicalComponents.reverse();
    },
  },
  {
    vectorId: 'manifest-unknown-field',
    expectedCode: 'UNKNOWN_FIELD',
    mutate(manifest) {
      manifest.contracts[0].iriTemplate = '{rawSourceValue}';
    },
  },
];
