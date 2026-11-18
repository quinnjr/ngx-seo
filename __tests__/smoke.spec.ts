import { describe, it, expect } from 'vitest';
import { DOCUMENT, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

describe('test environment', () => {
  it('provides the jsdom document through Angular DI', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    expect(TestBed.inject(DOCUMENT)).toBe(document);
  });
});
