if (!customElements.get('sunrise-product')) {
  customElements.define(
    'sunrise-product',
    class SunriseProduct extends HTMLElement {
      constructor() {
        super();
        this.onQuantityButtonClick = this.onQuantityButtonClick.bind(this);
        this.onCartUpdate = this.onCartUpdate.bind(this);
      }

      connectedCallback() {
        this.addEventListener('click', this.onQuantityButtonClick);
        this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, this.onCartUpdate);
        this.fetchNutrition();
      }

      disconnectedCallback() {
        this.removeEventListener('click', this.onQuantityButtonClick);
        this.cartUpdateUnsubscriber?.();
        this.cartSyncController?.abort();
        this.nutritionController?.abort();
      }

      async fetchNutrition() {
        const nutrition = this.querySelector('[data-sunrise-nutrition]');
        const grid = nutrition?.querySelector('[data-sunrise-nutrition-grid]');
        const apiUrl = this.dataset.nutritionApiUrl;
        const productHandle = this.dataset.productHandle;
        if (!nutrition || !grid || !apiUrl || !productHandle) return;

        this.nutritionController?.abort();
        this.nutritionController = new AbortController();

        try {
          const requestUrl = new URL(apiUrl, window.location.origin);
          requestUrl.searchParams.set('handle', productHandle);

          const response = await fetch(requestUrl.toString(), {
            headers: { Accept: 'application/json' },
            signal: this.nutritionController.signal,
          });
          const payload = await response.json();

          if (!response.ok) {
            throw new Error(payload?.error || 'Unable to load nutritional information.');
          }

          const facts = payload?.metafields?.nutrition_info;
          if (!Array.isArray(facts)) {
            throw new Error('The nutrition API returned an invalid response.');
          }

          const validFacts = facts.filter(
            (fact) => typeof fact?.type === 'string' && typeof fact?.value === 'string'
          );
          if (validFacts.length === 0) return;

          this.renderNutrition(grid, validFacts);
          nutrition.hidden = false;
        } catch (error) {
          if (error.name !== 'AbortError') {
            console.error('Unable to load nutritional information.', error);
          }
        }
      }

      renderNutrition(grid, facts) {
        const fragment = document.createDocumentFragment();

        facts.forEach((fact) => {
          const row = document.createElement('div');
          row.className = 'sunrise-product__nutrition-row nutrition-row';

          const label = document.createElement('span');
          label.className = 'sunrise-product__nutrition-label nutrition-label';
          label.textContent = fact.type;

          const value = document.createElement('span');
          value.className = 'sunrise-product__nutrition-value nutrition-value';
          value.textContent = fact.value;

          row.append(label, value);
          fragment.append(row);
        });

        grid.replaceChildren(fragment);
      }

      onQuantityButtonClick(event) {
        const button = event.target.closest('[data-quantity-action]');
        if (!button || !this.contains(button)) return;

        const control = button.closest('[data-sunrise-row-quantity]');
        if (!control || control.classList.contains('is-loading')) return;

        const input = control.querySelector('.sunrise-product__row-quantity-value');
        const currentQuantity = Number.parseInt(input.value, 10) || 0;
        const minimum = Number.parseInt(control.dataset.min, 10) || 1;
        const step = Number.parseInt(control.dataset.step, 10) || 1;
        const maximum = Number.parseInt(control.dataset.max, 10) || null;
        let nextQuantity;

        if (button.dataset.quantityAction === 'increase') {
          nextQuantity = currentQuantity === 0 ? minimum : currentQuantity + step;
          if (maximum && nextQuantity > maximum) return;
        } else {
          nextQuantity = currentQuantity - step;
          if (nextQuantity < minimum) nextQuantity = 0;
        }

        this.updateCartQuantity(control, nextQuantity);
      }

      async updateCartQuantity(control, quantity) {
        const variantId = control.dataset.variantId;
        const productForm = control.closest('product-form');
        productForm?.handleErrorMessage();
        this.setControlLoading(control, true);

        try {
          const body = JSON.stringify({
            updates: { [variantId]: quantity },
            sections: ['cart-icon-bubble'],
            sections_url: window.location.pathname,
          });
          const response = await fetch(`${routes.cart_update_url}`, { ...fetchConfig(), body });
          const cart = await response.json();

          if (!response.ok || cart.errors) {
            throw new Error(cart.description || cart.message || cart.errors || window.cartStrings.error);
          }

          this.renderCartIcon(cart.sections?.['cart-icon-bubble']);
          this.renderCartQuantities(cart);
          publish(PUB_SUB_EVENTS.cartUpdate, {
            source: this.updateSource,
            cartData: cart,
            variantId: Number.parseInt(variantId, 10),
          });
        } catch (error) {
          productForm?.handleErrorMessage(error.message || window.cartStrings.error);
          await this.fetchAndRenderCart();
        } finally {
          this.setControlLoading(control, false);
        }
      }

      onCartUpdate(event) {
        if (event.source === this.updateSource) return;

        if (event.cartData?.item_count !== undefined && Array.isArray(event.cartData.items)) {
          this.renderCartQuantities(event.cartData);
          return;
        }

        this.fetchAndRenderCart();
      }

      async fetchAndRenderCart() {
        this.cartSyncController?.abort();
        this.cartSyncController = new AbortController();

        try {
          const response = await fetch(`${routes.cart_url}.json`, { signal: this.cartSyncController.signal });
          if (!response.ok) throw new Error(window.cartStrings.error);
          this.renderCartQuantities(await response.json());
        } catch (error) {
          if (error.name !== 'AbortError') console.error(error);
        }
      }

      renderCartQuantities(cart) {
        const quantities = new Map();
        (cart.items || []).forEach((item) => {
          const variantId = String(item.variant_id || item.id);
          quantities.set(variantId, (quantities.get(variantId) || 0) + item.quantity);
        });

        this.querySelectorAll('[data-sunrise-row-quantity]').forEach((control) => {
          const quantity = quantities.get(control.dataset.variantId) || 0;
          const input = control.querySelector('.sunrise-product__row-quantity-value');
          const addButton = control.closest('.sunrise-product__variant-actions')?.querySelector('[data-sunrise-add]');

          if (input) input.value = quantity;
          control.hidden = quantity === 0;
          if (addButton) addButton.hidden = quantity > 0;
        });
      }

      renderCartIcon(sectionHtml) {
        const cartIcon = document.getElementById('cart-icon-bubble');
        if (!cartIcon || !sectionHtml) return;

        const section = new DOMParser().parseFromString(sectionHtml, 'text/html').querySelector('.shopify-section');
        if (section) cartIcon.innerHTML = section.innerHTML;
      }

      setControlLoading(control, loading) {
        control.classList.toggle('is-loading', loading);
        control.toggleAttribute('aria-busy', loading);
        control.querySelectorAll('button').forEach((button) => (button.disabled = loading));
        control.querySelector('.loading__spinner')?.classList.toggle('hidden', !loading);
      }

      get updateSource() {
        return `sunrise-product-${this.dataset.sectionId}`;
      }
    }
  );
}
