import { describe, it, expect } from 'vitest';
import {
  aggregateOffer,
  article,
  blogPosting,
  breadcrumbList,
  faqPage,
  howTo,
  offer,
  organization,
  person,
  product,
  qaPage,
  service,
  speakable,
  webPage,
  webSite,
} from '../src/lib/builders';

describe('JSON-LD builders', () => {
  it('faqPage builds questions with accepted answers', () => {
    expect(faqPage([{ question: 'Q', answer: 'A' }])).toEqual({
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Q', acceptedAnswer: { '@type': 'Answer', text: 'A' } }],
    });
  });

  it('faqPage accepts an input object with extras', () => {
    expect(faqPage({ items: [], '@id': '#faq' })).toEqual({ '@type': 'FAQPage', '@id': '#faq', mainEntity: [] });
  });

  it('breadcrumbList numbers items from 1', () => {
    expect(breadcrumbList([{ name: 'Home', url: '/' }, { name: 'Blog', url: '/blog' }, { name: 'Post' }])).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: '/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: '/blog' },
        { '@type': 'ListItem', position: 3, name: 'Post' },
      ],
    });
  });

  it('howTo numbers steps and wraps supplies and tools', () => {
    expect(
      howTo({ name: 'H', steps: [{ name: 'One', text: 'Do one' }, 'Do two'], supply: ['paper'], tool: ['pen'], totalTime: 'PT5M' }),
    ).toEqual({
      '@type': 'HowTo',
      name: 'H',
      totalTime: 'PT5M',
      supply: [{ '@type': 'HowToSupply', name: 'paper' }],
      tool: [{ '@type': 'HowToTool', name: 'pen' }],
      step: [
        { '@type': 'HowToStep', position: 1, name: 'One', text: 'Do one' },
        { '@type': 'HowToStep', position: 2, text: 'Do two' },
      ],
    });
  });

  it('qaPage builds the question with accepted and suggested answers', () => {
    expect(
      qaPage({
        question: 'Q?',
        text: 'Details',
        acceptedAnswer: { text: 'Yes', upvoteCount: 3 },
        suggestedAnswers: [{ text: 'Maybe' }],
      }),
    ).toEqual({
      '@type': 'QAPage',
      mainEntity: {
        '@type': 'Question',
        name: 'Q?',
        text: 'Details',
        answerCount: 2,
        acceptedAnswer: { '@type': 'Answer', text: 'Yes', upvoteCount: 3 },
        suggestedAnswer: [{ '@type': 'Answer', text: 'Maybe' }],
      },
    });
  });

  it('speakable lists selectors', () => {
    expect(speakable({ cssSelector: ['.summary'] })).toEqual({ '@type': 'SpeakableSpecification', cssSelector: ['.summary'] });
  });

  it('article and blogPosting expand author and publisher names', () => {
    const input = { headline: 'H', author: 'Ann', publisher: 'Acme', image: '/a.png', datePublished: '2026-01-01' };
    expect(article(input)).toEqual({
      '@type': 'Article',
      headline: 'H',
      author: { '@type': 'Person', name: 'Ann' },
      publisher: { '@type': 'Organization', name: 'Acme' },
      image: '/a.png',
      datePublished: '2026-01-01',
    });
    expect(blogPosting({ headline: 'H', author: ['Ann', { '@id': '/#bob' }], publisher: { '@id': '/#org' } })).toEqual({
      '@type': 'BlogPosting',
      headline: 'H',
      author: [{ '@type': 'Person', name: 'Ann' }, { '@id': '/#bob' }],
      publisher: { '@id': '/#org' },
    });
  });

  it('product wraps a brand name', () => {
    expect(product({ name: 'P', brand: 'B' })).toEqual({ '@type': 'Product', name: 'P', brand: { '@type': 'Brand', name: 'B' } });
  });

  it('aggregateOffer computes the range and passes the currency to its offers', () => {
    expect(aggregateOffer({ priceCurrency: 'USD', offers: [offer({ name: 'a', price: '3' }), offer({ price: '1' })] })).toEqual({
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: '1',
      highPrice: '3',
      offerCount: 2,
      offers: [
        { '@type': 'Offer', name: 'a', price: '3', priceCurrency: 'USD' },
        { '@type': 'Offer', price: '1', priceCurrency: 'USD' },
      ],
    });
  });

  it('aggregateOffer keeps explicit bounds', () => {
    const node = aggregateOffer({ priceCurrency: 'USD', lowPrice: 0, highPrice: 9, offers: [offer({ price: 5 })] });
    expect(node['lowPrice']).toBe(0);
    expect(node['highPrice']).toBe(9);
  });

  it('webPage, webSite, organization, person and service', () => {
    expect(webPage({ name: 'W', speakable: speakable({ xpath: ['/html/head/title'] }) })).toEqual({
      '@type': 'WebPage',
      name: 'W',
      speakable: { '@type': 'SpeakableSpecification', xpath: ['/html/head/title'] },
    });
    expect(webSite({ name: 'S', url: '/', searchUrlTemplate: '/search?q={search_term_string}' })).toEqual({
      '@type': 'WebSite',
      name: 'S',
      url: '/',
      potentialAction: {
        '@type': 'SearchAction',
        target: '/search?q={search_term_string}',
        'query-input': 'required name=search_term_string',
      },
    });
    expect(organization({ '@id': '/#org', name: 'O', logo: '/l.png', sameAs: ['https://x.test'] })).toEqual({
      '@type': 'Organization',
      '@id': '/#org',
      name: 'O',
      logo: '/l.png',
      sameAs: ['https://x.test'],
    });
    expect(person({ name: 'Ann', jobTitle: 'CEO' })).toEqual({ '@type': 'Person', name: 'Ann', jobTitle: 'CEO' });
    expect(service({ name: 'Sv', provider: 'Acme', serviceType: 'Review' })).toEqual({
      '@type': 'Service',
      name: 'Sv',
      provider: { '@type': 'Organization', name: 'Acme' },
      serviceType: 'Review',
    });
  });

  it('passes unknown properties through and lets @type be refined', () => {
    expect(organization({ name: 'x', foundingDate: '2020' })).toEqual({ '@type': 'Organization', name: 'x', foundingDate: '2020' });
    expect(webPage({ '@type': 'AboutPage', name: 'About' })['@type']).toBe('AboutPage');
  });

  it('aggregateOffer ignores offers without a usable price', () => {
    const node = aggregateOffer({ offers: [offer({ price: null as never }), offer({ price: '' }), offer({ price: '5' }), offer({ price: 'free' })] });
    expect(node['lowPrice']).toBe('5');
    expect(node['highPrice']).toBe('5');
  });
});
